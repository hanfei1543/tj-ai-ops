#!/usr/bin/env node
// VPS 推送器入口（cron：`node scripts/tj-po-push.mjs --once`，每分钟一轮）。
//
// 业务逻辑全部在 scripts/lib/po-push-core.mjs —— 可 import、可 mock 测试、import 无副作用。
// 本文件只做装配：读 env、建 REST/bridge 访问器、跑一轮或循环。
//
// 永久安全边界（见 core）：合并单与合并来源单拒绝推送；只走 public schema；
// 普通 standard 单保持原路径（7 列 PO_Lines -> bridge -> exported）。
import { pathToFileURL } from 'node:url'
import {
  createSupabaseRest,
  createBridgeCall,
  createPusher,
  POLL_SEC,
} from './lib/po-push-core.mjs'
import { loadEnvFile, ENV_PATH } from './lib/env.mjs'

export { loadEnvFile, ENV_PATH }

/**
 * 装配并运行推送器。依赖可注入，便于测试（测试不会触发真实网络）。
 * @param {{argv?: string[], env?: object, sbFetch?: Function, bridgeCall?: Function, log?: object, once?: boolean}} opts
 */
export async function startPusher(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2)
  const env = opts.env ?? loadEnvFile()
  const log = opts.log ?? console
  const once = opts.once ?? argv.includes('--once')

  const sbFetch =
    opts.sbFetch ??
    createSupabaseRest({
      url: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    })
  const bridgeCall = opts.bridgeCall ?? createBridgeCall()
  const pusher = createPusher({ sbFetch, bridgeCall, log })

  if (once) return pusher.runOnce()
  // 循环模式：单轮异常不影响下一轮
  for (;;) {
    try {
      await pusher.runOnce()
    } catch (e) {
      log.error('[loop]', e.message)
    }
    await new Promise((r) => setTimeout(r, POLL_SEC * 1000))
  }
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  try {
    await startPusher({ argv, ...opts })
    return 0
  } catch (e) {
    console.error(e.message || String(e))
    return 1
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().then((code) => {
    if (code !== 0) process.exit(code)
  })
}
