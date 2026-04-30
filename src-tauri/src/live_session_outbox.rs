use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{Row, SqlitePool};
use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

const DATABASE_FILE_NAME: &str = "live-session-outbox.sqlite3";
const SCHEMA_VERSION: i64 = 4;
const INSERT_BATCH_SIZE: usize = 200;
const DELETE_BATCH_SIZE: usize = 900;
const RESCHEDULE_BATCH_SIZE: usize = 180;
const OUTBOX_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const OUTBOX_PRUNE_INTERVAL_MS: i64 = 60 * 60 * 1000;
const SQLITE_BUSY_TIMEOUT_MS: u64 = 30_000;

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSessionOutboxDatabaseInfo {
    database_path: String,
    database_exists: bool,
    wal_exists: bool,
    shm_exists: bool,
    database_size_bytes: u64,
    wal_size_bytes: u64,
    shm_size_bytes: u64,
    total_size_bytes: u64,
    schema_version: i64,
    expected_schema_version: i64,
    journal_mode: String,
    pending_count: i64,
    busy_timeout_ms: u64,
    last_modified_ms: Option<i64>,
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

    let state = state.inner();
    recover_database_operation(&app, state, |pool| {
        let items = &items;
        async move { append_with_pool(&pool, state, items).await }
    })
    .await
}

async fn append_with_pool(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
    items: &[LiveSessionOutboxInsert],
) -> Result<u64, String> {
    prune_expired_if_needed(pool, state, current_time_ms()?).await?;
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
            .execute(pool)
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
    let state = state.inner();
    recover_database_operation(&app, state, |pool| async move {
        list_due_with_pool(&pool, state, now_ms, limit).await
    })
    .await
}

async fn list_due_with_pool(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
    now_ms: i64,
    limit: i64,
) -> Result<Vec<LiveSessionOutboxItem>, String> {
    prune_expired_if_needed(pool, state, now_ms).await?;
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
    .fetch_all(pool)
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

    let state = state.inner();
    recover_database_operation(&app, state, |pool| {
        let ids = &ids;
        async move { ack_with_pool(&pool, state, ids).await }
    })
    .await
}

async fn ack_with_pool(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
    ids: &[i64],
) -> Result<u64, String> {
    prune_expired_if_needed(pool, state, current_time_ms()?).await?;
    let mut deleted = 0;
    for batch in ids.chunks(DELETE_BATCH_SIZE) {
        let placeholders = vec!["?"; batch.len()].join(", ");
        let sql = format!("DELETE FROM live_session_outbox WHERE id IN ({placeholders})");
        let mut query = sqlx::query(&sql);
        for id in batch {
            query = query.bind(id);
        }
        deleted += query
            .execute(pool)
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

    let state = state.inner();
    recover_database_operation(&app, state, |pool| {
        let updates = &updates;
        async move { reschedule_with_pool(&pool, state, updates).await }
    })
    .await
}

async fn reschedule_with_pool(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
    updates: &[LiveSessionOutboxRescheduleUpdate],
) -> Result<u64, String> {
    prune_expired_if_needed(pool, state, current_time_ms()?).await?;
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
            .execute(pool)
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
    let state = state.inner();
    recover_database_operation(&app, state, |pool| async move {
        count_pending_with_pool(&pool, state).await
    })
    .await
}

async fn count_pending_with_pool(
    pool: &SqlitePool,
    state: &LiveSessionOutboxState,
) -> Result<i64, String> {
    prune_expired_if_needed(pool, state, current_time_ms()?).await?;
    count_pending_rows(pool).await
}

#[tauri::command]
pub async fn live_session_outbox_database_info(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
) -> Result<LiveSessionOutboxDatabaseInfo, String> {
    let path = database_path(&app)?;
    let state = state.inner();
    recover_database_operation(&app, state, |pool| {
        let path = &path;
        async move { database_info_with_pool(path, &pool).await }
    })
    .await
}

#[tauri::command]
pub async fn live_session_outbox_rebuild_database(
    app: AppHandle,
    state: State<'_, LiveSessionOutboxState>,
) -> Result<LiveSessionOutboxDatabaseInfo, String> {
    let state = state.inner();
    reset_cached_database(&app, state).await?;
    let path = database_path(&app)?;
    let pool = get_pool(&app, state).await?;
    database_info_with_pool(&path, &pool).await
}

async fn database_info_with_pool(
    path: &Path,
    pool: &SqlitePool,
) -> Result<LiveSessionOutboxDatabaseInfo, String> {
    let schema_version = read_schema_version(pool).await?;
    let journal_mode = read_journal_mode(pool).await?;
    let pending_count = count_pending_rows(pool).await?;
    let database_size_bytes = file_size(path)?;
    let wal_path = wal_path(path);
    let shm_path = shm_path(path);
    let wal_size_bytes = file_size(&wal_path)?;
    let shm_size_bytes = file_size(&shm_path)?;

    Ok(LiveSessionOutboxDatabaseInfo {
        database_path: path.display().to_string(),
        database_exists: path.exists(),
        wal_exists: wal_path.exists(),
        shm_exists: shm_path.exists(),
        database_size_bytes,
        wal_size_bytes,
        shm_size_bytes,
        total_size_bytes: database_size_bytes + wal_size_bytes + shm_size_bytes,
        schema_version,
        expected_schema_version: SCHEMA_VERSION,
        journal_mode,
        pending_count,
        busy_timeout_ms: SQLITE_BUSY_TIMEOUT_MS,
        last_modified_ms: latest_modified_ms([path, &wal_path, &shm_path])?,
    })
}

async fn read_journal_mode(pool: &SqlitePool) -> Result<String, String> {
    let row = sqlx::query("PRAGMA journal_mode")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("读取 outbox journal 模式失败: {error}"))?;
    let journal_mode: String = row.try_get(0).map_err(sql_row_error)?;
    Ok(journal_mode.to_ascii_uppercase())
}

async fn count_pending_rows(pool: &SqlitePool) -> Result<i64, String> {
    let row = sqlx::query("SELECT COUNT(*) FROM live_session_outbox")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("统计 outbox 失败: {error}"))?;
    row.try_get(0).map_err(sql_row_error)
}

async fn recover_database_operation<T, F, Fut>(
    app: &AppHandle,
    state: &LiveSessionOutboxState,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut(SqlitePool) -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let mut reconnected_after_locked = false;
    let mut rebuilt = false;
    loop {
        let pool = match get_pool(app, state).await {
            Ok(pool) => pool,
            Err(error) if is_sqlite_locked_error(&error) && !reconnected_after_locked => {
                close_cached_pool(state).await?;
                reconnected_after_locked = true;
                continue;
            }
            Err(error) if is_sqlite_resettable_error(&error) && !rebuilt => {
                reset_cached_database(app, state).await?;
                rebuilt = true;
                continue;
            }
            Err(error) => return Err(error),
        };

        match operation(pool).await {
            Ok(result) => return Ok(result),
            Err(error) if is_sqlite_locked_error(&error) && !reconnected_after_locked => {
                close_cached_pool(state).await?;
                reconnected_after_locked = true;
            }
            Err(error) if is_sqlite_resettable_error(&error) && !rebuilt => {
                reset_cached_database(app, state).await?;
                rebuilt = true;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn close_cached_pool(state: &LiveSessionOutboxState) -> Result<(), String> {
    let pool = state
        .pool
        .lock()
        .map_err(|_| "outbox pool lock poisoned".to_string())?
        .take();
    if let Some(pool) = pool {
        pool.close().await;
    }
    Ok(())
}

async fn reset_cached_database(
    app: &AppHandle,
    state: &LiveSessionOutboxState,
) -> Result<(), String> {
    close_cached_pool(state).await?;
    let path = database_path(app)?;
    delete_database_files(&path)?;
    *state
        .last_prune_at_ms
        .lock()
        .map_err(|_| "outbox prune lock poisoned".to_string())? = 0;
    Ok(())
}

async fn get_pool(app: &AppHandle, state: &LiveSessionOutboxState) -> Result<SqlitePool, String> {
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
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 outbox 数据库目录失败 {}: {error}", parent.display()))?;
    }

    let pool = match open_pool(&path).await {
        Ok(pool) => pool,
        Err(error) if is_sqlite_resettable_error(&error) => {
            delete_database_files(&path)?;
            open_pool(&path).await?
        }
        Err(error) => return Err(error),
    };

    match ensure_schema(&path, pool).await {
        Ok(pool) => Ok(pool),
        Err(error) if is_sqlite_resettable_error(&error) => {
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
        .journal_mode(SqliteJournalMode::Delete)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS));

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("打开 outbox 数据库失败 {}: {error}", path.display()))
}

async fn ensure_schema(path: &Path, pool: SqlitePool) -> Result<SqlitePool, String> {
    let version = match read_schema_version(&pool).await {
        Ok(version) => version,
        Err(error) if is_sqlite_resettable_error(&error) => {
            pool.close().await;
            return Err(error);
        }
        Err(error) => return Err(error),
    };

    if version != 0 && version != SCHEMA_VERSION {
        pool.close().await;
        delete_database_files(path)?;
        let fresh_pool = open_pool(path).await?;
        initialize_schema(&fresh_pool).await?;
        return Ok(fresh_pool);
    }

    if let Err(error) = initialize_schema(&pool).await {
        if is_sqlite_resettable_error(&error) {
            pool.close().await;
        }
        return Err(error);
    }

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
        let last_prune_at_ms = state
            .last_prune_at_ms
            .lock()
            .map_err(|_| "outbox prune lock poisoned".to_string())?;
        now_ms - *last_prune_at_ms >= OUTBOX_PRUNE_INTERVAL_MS
    };

    if !should_prune {
        return Ok(());
    }

    sqlx::query("DELETE FROM live_session_outbox WHERE event_ts_ms < ?")
        .bind(now_ms - OUTBOX_RETENTION_MS)
        .execute(pool)
        .await
        .map_err(|error| format!("清理 outbox 过期记录失败: {error}"))?;

    *state
        .last_prune_at_ms
        .lock()
        .map_err(|_| "outbox prune lock poisoned".to_string())? = now_ms;
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

fn wal_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-wal", database_path.display()))
}

fn shm_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-shm", database_path.display()))
}

fn rollback_journal_path(database_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}-journal", database_path.display()))
}

fn delete_database_files(database_path: &Path) -> Result<(), String> {
    for path in [
        database_path.to_path_buf(),
        wal_path(database_path),
        shm_path(database_path),
        rollback_journal_path(database_path),
    ] {
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

fn file_size(path: &Path) -> Result<u64, String> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!(
            "读取数据库文件信息失败 {}: {error}",
            path.display()
        )),
    }
}

fn latest_modified_ms(paths: [&Path; 3]) -> Result<Option<i64>, String> {
    let mut latest: Option<i64> = None;
    for path in paths {
        let modified = match fs::metadata(path) {
            Ok(metadata) => metadata
                .modified()
                .map_err(|error| format!("读取数据库更新时间失败 {}: {error}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "读取数据库文件信息失败 {}: {error}",
                    path.display()
                ));
            }
        };
        let modified_ms = unix_time_ms(modified)?;
        latest = Some(latest.map_or(modified_ms, |current| current.max(modified_ms)));
    }
    Ok(latest)
}

fn current_time_ms() -> Result<i64, String> {
    unix_time_ms(std::time::SystemTime::now())
}

fn unix_time_ms(time: std::time::SystemTime) -> Result<i64, String> {
    let timestamp = time
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("系统时间无效: {error}"))?;
    Ok(timestamp.as_millis().min(i64::MAX as u128) as i64)
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

fn is_sqlite_locked_error(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    [
        "database is locked",
        "database table is locked",
        "sqlite_busy",
        "sqlite_locked",
        "code: 5",
    ]
    .iter()
    .any(|pattern| normalized.contains(pattern))
}

fn is_sqlite_resettable_error(error: &str) -> bool {
    is_sqlite_corruption_error(error) || is_sqlite_locked_error(error)
}

fn sql_row_error(error: sqlx::Error) -> String {
    format!("读取 outbox 字段失败: {error}")
}

#[cfg(test)]
mod tests {
    use super::{is_sqlite_corruption_error, is_sqlite_locked_error, is_sqlite_resettable_error};

    #[test]
    fn classifies_sqlite_locked_as_resettable_without_treating_it_as_corruption() {
        let error = "error returned from database: (code: 5) database is locked";

        assert!(is_sqlite_locked_error(error));
        assert!(is_sqlite_resettable_error(error));
        assert!(!is_sqlite_corruption_error(error));
    }
}
