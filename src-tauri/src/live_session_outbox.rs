use serde::{Deserialize, Serialize};
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const DATABASE_FILE_NAME: &str = "live-session-outbox.sqlite3";
const SCHEMA_VERSION: i64 = 4;
const INSERT_BATCH_SIZE: usize = 200;
const DELETE_BATCH_SIZE: usize = 900;
const RESCHEDULE_BATCH_SIZE: usize = 180;
const OUTBOX_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_PRUNE_INTERVAL_MS: i64 = 60 * 60 * 1000;

pub struct LiveSessionOutboxState {
    pool: Mutex<Option<SqlitePool>>,
    last_prune_at_ms: Mutex<i64>,
}

impl Default for LiveSessionOutboxState {
    fn default() -> Self {
        Self {
            pool: Mutex::new(None),
            last_prune_at_ms: Mutex::new(0),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionOutboxInsert {
    streamer_uid: i64,
    event_ts_ms: i64,
    payload: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionOutboxRescheduleUpdate {
    id: i64,
    retry_count: i64,
    next_retry_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionOutboxItem {
    id: i64,
    streamer_uid: i64,
    event_ts_ms: i64,
    payload: Vec<u8>,
    retry_count: i64,
    next_retry_at_ms: i64,
}

#[tauri::command]
pub async fn live_session_outbox_append(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
    items: Vec<LiveSessionOutboxInsert>,
) -> Result<u64, String> {
    if items.is_empty() {
        return Ok(0);
    }

    let pool = get_pool(&app, &state).await?;
    prune_expired_if_needed(&pool, &state, current_time_ms()?).await?;

    let mut inserted = 0;
    for batch in items.chunks(INSERT_BATCH_SIZE) {
        let value_sql = vec!["(?, ?, ?, 0, ?)"; batch.len()].join(", ");
        let sql = format!(
            "INSERT INTO live_session_outbox \
             (streamer_uid, event_ts_ms, payload, retry_count, next_retry_at_ms) \
             VALUES {value_sql}"
        );
        let mut query = sqlx::query(&sql);
        for item in batch {
            query = query
                .bind(item.streamer_uid)
                .bind(item.event_ts_ms)
                .bind(item.payload.as_slice())
                .bind(item.event_ts_ms);
        }
        inserted += query
            .execute(&pool)
            .await
            .map_err(|error| format!("写入 outbox 失败: {error}"))?
            .rows_affected();
    }

    Ok(inserted)
}

#[tauri::command]
pub async fn live_session_outbox_list_due(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
    now_ms: i64,
    limit: i64,
) -> Result<Vec<LiveSessionOutboxItem>, String> {
    let pool = get_pool(&app, &state).await?;
    prune_expired_if_needed(&pool, &state, now_ms).await?;

    let normalized_limit = limit.clamp(1, 2000);
    let rows = sqlx::query(
        "SELECT id, streamer_uid, event_ts_ms, payload, retry_count, next_retry_at_ms \
         FROM live_session_outbox \
         WHERE next_retry_at_ms <= ? \
         ORDER BY next_retry_at_ms ASC, id ASC \
         LIMIT ?",
    )
    .bind(now_ms)
    .bind(normalized_limit)
    .fetch_all(&pool)
    .await
    .map_err(|error| format!("读取 outbox 失败: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(LiveSessionOutboxItem {
                id: row.try_get(0).map_err(sql_row_error)?,
                streamer_uid: row.try_get(1).map_err(sql_row_error)?,
                event_ts_ms: row.try_get(2).map_err(sql_row_error)?,
                payload: row.try_get(3).map_err(sql_row_error)?,
                retry_count: row.try_get(4).map_err(sql_row_error)?,
                next_retry_at_ms: row.try_get(5).map_err(sql_row_error)?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn live_session_outbox_ack(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
    ids: Vec<i64>,
) -> Result<u64, String> {
    let ids = normalize_ids(ids);
    if ids.is_empty() {
        return Ok(0);
    }

    let pool = get_pool(&app, &state).await?;
    prune_expired_if_needed(&pool, &state, current_time_ms()?).await?;

    let mut deleted = 0;
    for batch in ids.chunks(DELETE_BATCH_SIZE) {
        let placeholders = vec!["?"; batch.len()].join(", ");
        let sql = format!("DELETE FROM live_session_outbox WHERE id IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for id in batch {
            query = query.bind(id);
        }
        deleted += query
            .execute(&pool)
            .await
            .map_err(|error| format!("删除 outbox 失败: {error}"))?
            .rows_affected();
    }

    Ok(deleted)
}

#[tauri::command]
pub async fn live_session_outbox_reschedule(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
    updates: Vec<LiveSessionOutboxRescheduleUpdate>,
) -> Result<u64, String> {
    let updates = normalize_reschedule_updates(updates);
    if updates.is_empty() {
        return Ok(0);
    }

    let pool = get_pool(&app, &state).await?;
    prune_expired_if_needed(&pool, &state, current_time_ms()?).await?;

    let mut updated = 0;
    for batch in updates.chunks(RESCHEDULE_BATCH_SIZE) {
        let retry_cases = vec!["WHEN ? THEN ?"; batch.len()].join(" ");
        let next_retry_cases = vec!["WHEN ? THEN ?"; batch.len()].join(" ");
        let id_placeholders = vec!["?"; batch.len()].join(", ");
        let sql = format!(
            "UPDATE live_session_outbox \
             SET retry_count = CASE id {retry_cases} ELSE retry_count END, \
                 next_retry_at_ms = CASE id {next_retry_cases} ELSE next_retry_at_ms END \
             WHERE id IN ({id_placeholders})"
        );

        let mut query = sqlx::query(&sql);
        for update in batch {
            query = query.bind(update.id).bind(update.retry_count);
        }
        for update in batch {
            query = query.bind(update.id).bind(update.next_retry_at_ms);
        }
        for update in batch {
            query = query.bind(update.id);
        }

        updated += query
            .execute(&pool)
            .await
            .map_err(|error| format!("重排 outbox 失败: {error}"))?
            .rows_affected();
    }

    Ok(updated)
}

#[tauri::command]
pub async fn live_session_outbox_count_pending(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
) -> Result<i64, String> {
    let pool = get_pool(&app, &state).await?;
    prune_expired_if_needed(&pool, &state, current_time_ms()?).await?;

    let row = sqlx::query("SELECT COUNT(*) FROM live_session_outbox")
        .fetch_one(&pool)
        .await
        .map_err(|error| format!("统计 outbox 失败: {error}"))?;
    row.try_get(0).map_err(sql_row_error)
}

async fn get_pool(
    app: &AppHandle,
    state: &LiveSessionOutboxState,
) -> Result<SqlitePool, String> {
    if let Some(pool) = state
        .pool
        .lock()
        .map_err(|_| "outbox pool lock poisoned".to_string())?
        .clone()
    {
        return Ok(pool);
    }

    let pool = open_initialized_pool(app).await?;
    *state
        .pool
        .lock()
        .map_err(|_| "outbox pool lock poisoned".to_string())? = Some(pool.clone());
    Ok(pool)
}

async fn open_initialized_pool(app: &AppHandle) -> Result<SqlitePool, String> {
    let path = database_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("创建 outbox 数据库目录失败 {}: {error}", parent.display())
        })?;
    }

    let pool = match open_pool(&path).await {
        Ok(pool) => pool,
        Err(error) if is_sqlite_corruption_error(&error) => {
            delete_database_files(&path)?;
            open_pool(&path).await?
        }
        Err(error) => return Err(error),
    };

    match ensure_schema(&path, pool).await {
        Ok(pool) => Ok(pool),
        Err(error) if is_sqlite_corruption_error(&error) => {
            delete_database_files(&path)?;
            let pool = open_pool(&path).await?;
            initialize_schema(&pool).await?;
            Ok(pool)
        }
        Err(error) => Err(error),
    }
}

async fn open_pool(path: &Path) -> Result<SqlitePool, String> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("打开 outbox 数据库失败 {}: {error}", path.display()))
}

async fn ensure_schema(path: &Path, pool: SqlitePool) -> Result<SqlitePool, String> {
    let version = read_schema_version(&pool).await?;
    if version != 0 && version != SCHEMA_VERSION {
        pool.close().await;
        delete_database_files(path)?;
        let fresh_pool = open_pool(path).await?;
        initialize_schema(&fresh_pool).await?;
        return Ok(fresh_pool);
    }

    initialize_schema(&pool).await?;
    Ok(pool)
}

async fn read_schema_version(pool: &SqlitePool) -> Result<i64, String> {
    let row = sqlx::query("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("读取 outbox schema 版本失败: {error}"))?;
    row.try_get(0).map_err(sql_row_error)
}

async fn initialize_schema(pool: &SqlitePool) -> Result<(), String> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS live_session_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            streamer_uid INTEGER NOT NULL,
            event_ts_ms INTEGER NOT NULL,
            payload BLOB NOT NULL,
            retry_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at_ms INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("创建 outbox 表失败: {error}"))?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_live_session_outbox_due
         ON live_session_outbox(next_retry_at_ms, id)",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("创建 outbox due 索引失败: {error}"))?;

    sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
        .execute(pool)
        .await
        .map_err(|error| format!("写入 outbox schema 版本失败: {error}"))?;
    Ok(())
}

async fn prune_expired_if_needed(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
    now_ms: i64,
) -> Result<(), String> {
    let should_prune = {
        let mut last_prune_at_ms = state
            .last_prune_at_ms
            .lock()
            .map_err(|_| "outbox prune lock poisoned".to_string())?;
        if now_ms - *last_prune_at_ms < OUTBOX_PRUNE_INTERVAL_MS {
            false
        } else {
            *last_prune_at_ms = now_ms;
            true
        }
    };

    if !should_prune {
        return Ok(());
    }

    sqlx::query("DELETE FROM live_session_outbox WHERE event_ts_ms < ?")
        .bind(now_ms - OUTBOX_RETENTION_MS)
        .execute(pool)
        .await
        .map_err(|error| format!("清理 outbox 过期记录失败: {error}"))?;
    Ok(())
}

fn normalize_ids(mut ids: Vec<i64>) -> Vec<i64> {
    ids.iter_mut().for_each(|id| *id = (*id).max(0));
    ids.sort_unstable();
    ids.dedup();
    ids.into_iter().filter(|id| *id > 0).collect()
}

fn normalize_reschedule_updates(
    updates: Vec<LiveSessionOutboxRescheduleUpdate>,
) -> Vec<LiveSessionOutboxRescheduleUpdate> {
    let mut normalized = BTreeMap::new();
    for update in updates {
        if update.id > 0 {
            normalized.insert(update.id, update);
        }
    }
    normalized.into_values().collect()
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法获取应用配置目录: {error}"))?
        .join(DATABASE_FILE_NAME))
}

fn delete_database_files(database_path: &Path) -> Result<(), String> {
    let wal_path = PathBuf::from(format!("{}-wal", database_path.display()));
    let shm_path = PathBuf::from(format!("{}-shm", database_path.display()));
    for path in [database_path.to_path_buf(), wal_path, shm_path] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("删除数据库文件失败 {}: {error}", path.display()));
            }
        }
    }
    Ok(())
}

fn current_time_ms() -> Result<i64, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("系统时间无效: {error}"))?;
    Ok(now.as_millis().min(i64::MAX as u128) as i64)
}

fn is_sqlite_corruption_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    [
        "database disk image is malformed",
        "file is not a database",
        "not a database",
        "sqlite_corrupt",
        "sqlite_notadb",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

fn sql_row_error(error: sqlx::Error) -> String {
    format!("读取 outbox 字段失败: {error}")
}
