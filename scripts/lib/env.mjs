// env 文件读取（只给 CLI 入口用；模块本身不读 env，测试不需要凭据）。
import fs from 'node:fs'

export const ENV_PATH = '/home/hermes/.hermes/.env'

/** 读 KEY=VALUE 形式 env 文件（不打印、不外传、不写入日志） */
export function loadEnvFile(p = ENV_PATH) {
  const env = {}
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m) env[m[1]] = m[2]
  }
  return env
}
