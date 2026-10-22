/**
 * 构建信息（单一来源）。
 *
 * 两个变量都由 CI 注入：
 *  - NEXT_PUBLIC_BUILD_SEQ  = github.run_number（每次 CI 运行单调递增）
 *  - NEXT_PUBLIC_BUILD_DATE = 构建时间戳（客户端包用于版本显示）
 *
 * 通过 next.config.ts 的 env 映射，值在构建期被内联进产物：
 * 服务端（standalone 的 server.js 运行时）拿不到 CI 环境变量，
 * 若在运行时读 process.env 会永远为空，因此必须依赖构建期内联。
 */
export const BUILD_SEQ = process.env.NEXT_PUBLIC_BUILD_SEQ || "";
export const BUILD_DATE = process.env.NEXT_PUBLIC_BUILD_DATE || "";
