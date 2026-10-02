// GitHub Actions 中转脚本：在境外 runner 上调用 WAPPSTORE 后台 API。
// 读取 .wappstore/job.json，执行其中的 jobs，把结果写进 .wappstore/last-result.json。
// 密码来自环境变量 WAPPS_PASSWORD（GitHub Secret），绝不写入输出。
import { readFileSync, writeFileSync } from 'node:fs'

const JOB_PATH = '.wappstore/job.json'
const RESULT_PATH = '.wappstore/last-result.json'

const job = JSON.parse(readFileSync(JOB_PATH, 'utf8'))
const API = (job.api || 'https://wappstore.wpr101218.workers.dev').replace(/\/+$/, '')
const PASSWORD = process.env.WAPPS_PASSWORD || ''
const DRY = job.dryRun === true

const result = { startedAt: new Date().toISOString(), api: API, dryRun: DRY, jobs: [], ok: true }

/** 所有输出都经过脱敏 */
function log(msg) {
  const s = String(msg).replace(/(token"?\s*[:=]\s*")[^"]+/gi, '$1<redacted>')
  console.log(s)
}

async function call(method, path, body, token) {
  const headers = { accept: 'application/json' }
  if (body) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45000),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, json, text: text.slice(0, 800) }
}

async function main() {
  if (!PASSWORD) throw new Error('缺少 WAPPS_PASSWORD（GitHub Secret 未配置）')

  log(`→ 连接 ${API}`)
  const conn = await call('GET', '/api/config')
  log(`  站点连通性：HTTP ${conn.status}`)
  if (conn.status !== 200) throw new Error(`站点不可达：HTTP ${conn.status} ${conn.text}`)
  result.siteConfig = conn.json || conn.text
  log('  站点配置：' + JSON.stringify(conn.json || conn.text).slice(0, 500))

  // —— 诊断：确认 Secret 是否原样送达（只记录长度与哈希前缀，不泄露值）——
  const { createHash } = await import('node:crypto')
  result.passwordDiag = {
    length: PASSWORD.length,
    sha256_12: createHash('sha256').update(PASSWORD, 'utf8').digest('hex').slice(0, 12),
    hasWhitespace: /\s/.test(PASSWORD),
    hasQuotes: /["']/.test(PASSWORD),
  }
  log(`  密码诊断：长度=${result.passwordDiag.length} sha256前12=${result.passwordDiag.sha256_12} 含空白=${result.passwordDiag.hasWhitespace} 含引号=${result.passwordDiag.hasQuotes}`)

  // —— 尝试多个可能的账号名 ——
  const candidates = ['admin', 'ai', 'administrator', 'wan101218', 'dev', 'Admin', 'ADMIN', 'root']
  let login = null
  let usedUser = ''
  for (const u of candidates) {
    const r = await call('POST', '/api/auth/login', { username: u, password: PASSWORD })
    result.loginAttempts = result.loginAttempts || []
    result.loginAttempts.push({ username: u, status: r.status, ok: !!(r.json && r.json.ok), error: r.json && r.json.error })
    log(`  尝试账号 ${u} → HTTP ${r.status} ${(r.json && (r.json.error || (r.json.ok ? 'ok' : ''))) || ''}`)
    if (r.status === 200 && r.json && r.json.ok) { login = r; usedUser = u; break }
    login = r
  }
  if (!login || login.status !== 200 || !login.json || !login.json.ok) {
    throw new Error(`登录失败：HTTP ${login && login.status} ${JSON.stringify((login && (login.json || login.text)) || '').slice(0, 200)}`)
  }
  const token = login.json.token
  log(`✓ 已登录 ${usedUser}（scope=ai）`)
  result.login = 'ok'
  result.loginUser = usedUser

  const listRes = await call('GET', '/api/admin/apps', null, token)
  const apps = (listRes.json && (listRes.json.apps || [])) || []
  log(`  后台当前应用数：${apps.length}`)

  let lastAppId = 0

  for (const j of job.jobs || []) {
    const entry = { action: j.action, ok: false }
    try {
      if (j.action === 'publish-app') {
        const p = j.payload || {}
        const exist = apps.find((a) => a.packageName && a.packageName === p.packageName)
        if (DRY) {
          entry.ok = true
          entry.dryRun = true
          entry.would = exist ? `update #${exist.id}` : 'create'
        } else {
          const res = exist
            ? await call('PUT', `/api/admin/apps/${exist.id}`, p, token)
            : await call('POST', '/api/admin/apps', p, token)
          entry.status = res.status
          entry.response = res.json || res.text
          entry.ok = res.status === 200 && !!(res.json && res.json.ok)
          lastAppId = (res.json && ((res.json.app && res.json.app.id) || res.json.id)) || (exist && exist.id) || 0
          entry.appId = lastAppId
          if (entry.ok) log(`✓ ${exist ? '已更新' : '已创建'}应用 ${p.name} v${p.versionName}（id=${lastAppId}）`)
          else log(`✗ 应用写入失败：${JSON.stringify(res.json || res.text).slice(0, 300)}`)
          if (res.json && res.json.warning) log(`  ⚠ ${res.json.warning}`)
        }
      } else if (j.action === 'create-banner') {
        const p = { ...(j.payload || {}) }
        if (!p.appId && lastAppId) p.appId = lastAppId
        if (DRY) {
          entry.ok = true
          entry.dryRun = true
        } else {
          const res = await call('POST', '/api/admin/banners', p, token)
          entry.status = res.status
          entry.response = res.json || res.text
          entry.ok = res.status === 200 && !!(res.json && res.json.ok)
          entry.bannerId = res.json && ((res.json.banner && res.json.banner.id) || res.json.id)
          if (entry.ok) log(`✓ 已创建宣传位「${p.title}」（id=${entry.bannerId}, appId=${p.appId}）`)
          else log(`✗ 宣传位创建失败：${JSON.stringify(res.json || res.text).slice(0, 300)}`)
        }
      } else if (j.action === 'list') {
        entry.ok = true
        entry.apps = apps.map((a) => ({ id: a.id, name: a.name, pkg: a.packageName, v: a.versionName, code: a.versionCode, scope: a.scope, status: a.status }))
        const b = await call('GET', '/api/admin/banners', null, token)
        entry.banners = ((b.json && (b.json.banners || b.json.data)) || []).map((x) => ({ id: x.id, title: x.title, enabled: x.enabled, appId: x.appId }))
      } else {
        entry.ok = false
        entry.error = 'unknown action: ' + j.action
      }
    } catch (e) {
      entry.ok = false
      entry.error = String(e.message || e)
    }
    result.jobs.push(entry)
    if (!entry.ok) result.ok = false
  }

  log('完成')
}

try {
  await main()
} catch (e) {
  result.ok = false
  result.error = String(e.message || e)
  log('ERR: ' + result.error)
}
result.finishedAt = new Date().toISOString()
writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8')
console.log('result written to ' + RESULT_PATH)
