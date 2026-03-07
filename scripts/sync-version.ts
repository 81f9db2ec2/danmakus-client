import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.cwd();
const packageJsonPath = join(rootDir, 'package.json');
const cargoTomlPath = join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfigPath = join(rootDir, 'src-tauri', 'tauri.conf.json');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
const version = packageJson.version?.trim();

if (!version) {
  throw new Error('package.json 缺少 version');
}

const cargoToml = readFileSync(cargoTomlPath, 'utf8');
const cargoVersionPattern = /(^version\s*=\s*")[^"]+("\s*$)/m;

if (!cargoVersionPattern.test(cargoToml)) {
  throw new Error('未找到 src-tauri/Cargo.toml 中的 version');
}

const nextCargoToml = cargoToml.replace(cargoVersionPattern, `$1${version}$2`);

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as { version?: string };
tauriConfig.version = version;

writeFileSync(cargoTomlPath, nextCargoToml);
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

console.log(`Synced client version to ${version}`);
