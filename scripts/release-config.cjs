function repositorySlug(value) {
  if (typeof value !== 'string') return
  const raw = value.trim().replace(/^(?:git\+)?https:\/\/github\.com\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '')
  if (/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(raw) && !['.', '..'].includes(raw.split('/')[1])) return raw
}
function releaseConfiguration(env, pkg) {
  const input = env.GITHUB_REPOSITORY || (typeof pkg.repository === 'object' ? pkg.repository.url : pkg.repository)
  const slug = repositorySlug(input)
  if (input && !slug) throw new Error('GitHub 仓库地址格式错误，请使用 用户名/仓库名 或 https://github.com/用户名/仓库名。')
  if (!slug) return { publish: null }
  const [owner, repo] = slug.split('/')
  return {
    publish: [{ provider: 'github', owner, repo, releaseType: 'release', vPrefixedTagName: true }],
    extraMetadata: { repository: { type: 'git', url: `https://github.com/${slug}.git` } }
  }
}
function validateTag(tag, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`) throw new Error(`标签必须与 package.json 正式版本一致：期望 v${version}，收到 ${tag}。`)
}
module.exports = { repositorySlug, releaseConfiguration, validateTag }
