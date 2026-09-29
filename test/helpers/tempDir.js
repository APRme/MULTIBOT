// 测试专用临时目录: 统一落到工作区 <repo>/.temp/test-run/ 下, 不再污染系统 %TEMP%。
//
// 背景: 测试里有大量 fs.mkdtempSync(path.join(os.tmpdir(), 'multibot-xxx-')) 调用
// (botRuntime 的 createRuntime、barkNotifier 的 createNotifier、loadMasterConfig 的
// repoRoot 工厂等), 每跑一次全量测试会在系统临时目录里留下 250+ 个目录, 而且**没有任何
// 清理逻辑**, 长期累积会把 C:\Users\<用户>\AppData\Local\Temp 塞满 multibot-* 目录。
//
// 做法: 本模块被 require 时(见各测试文件顶部的副作用 require)把 TEMP/TMP/TMPDIR 指向
// 工作区内的 .temp/test-run/, 于是既有的 os.tmpdir() 调用点无需改动就落在工作区内,
// 也顺带覆盖子进程(它们继承同一份 env)。.temp/ 已在 .gitignore 中排除。
//
// 若工作区不可写则保持系统默认, 保证测试仍能跑。
//
// 新测试建议直接用 makeTempDir('multibot-xxx-'), 语义更明确。
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEST_TEMP_ROOT = path.join(REPO_ROOT, '.temp', 'test-run');

// 必须在改写环境变量之前取一次系统默认值, 作为兜底
const SYSTEM_TEMP_ROOT = os.tmpdir();

function tryEnsureRoot() {
  try {
    fs.mkdirSync(TEST_TEMP_ROOT, { recursive: true });
    return true;
  } catch (error) {
    return false;
  }
}

const redirectEnabled = tryEnsureRoot();

if (redirectEnabled) {
  process.env.TEMP = TEST_TEMP_ROOT;
  process.env.TMP = TEST_TEMP_ROOT;
  process.env.TMPDIR = TEST_TEMP_ROOT;
}

function getTestTempRoot() {
  return redirectEnabled ? TEST_TEMP_ROOT : SYSTEM_TEMP_ROOT;
}

// 在测试临时根目录下新建一个唯一目录, 返回绝对路径
function makeTempDir(prefix = 'multibot-test-') {
  const root = getTestTempRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

module.exports = {
  makeTempDir,
  getTestTempRoot,
  TEST_TEMP_ROOT,
  SYSTEM_TEMP_ROOT,
  redirectEnabled
};
