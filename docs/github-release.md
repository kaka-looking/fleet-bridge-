# 上传 GitHub 与自动更新

本文说明舰桥 Fleet Bridge 当前源码的上传、构建与发布方式，依据本项目现有的工作流和发布脚本编写。

当前版本为 `0.1.6`。源码推送与安装包发布是两个独立步骤：主分支推送触发测试，正式版本标签触发 Windows 安装包发布。

## 1. 上传前准备

在项目根目录打开 PowerShell，使用 Node.js 22.12 或更新版本安装依赖并验证：

```powershell
npm ci
npm test
npm run build
npm run test:updates
```

涉及更新界面的改动，还应运行：

```powershell
npm run test:updates-ui
```

只上传本项目目录中的源码、必要资源、文档、锁文件、测试源码和工作流。不上传依赖目录、构建输出、安装包、测试截图、验收报告或本地应用数据；这些内容已列入项目的忽略规则。

提交前检查是否包含真实密钥、访问令牌、私人对话、个人路径或日常使用的配置文件。另行确认 Git 提交所使用的姓名与邮箱是否适合公开；它们不属于源码文件内容。

## 2. 首次上传源码

先创建一个空的 GitHub 公开仓库。以下示例中的 `YOUR_GITHUB_NAME` 是占位符，必须替换成实际仓库所有者；仓库名不是 `fleet-bridge` 时也要相应调整。

以下命令仅适用于尚未初始化 Git 的本项目目录：

```powershell
git init
git add .
git diff --cached --name-only
git diff --cached
```

确认暂存区只包含计划公开的文件，再提交并推送：

```powershell
git commit -m "Initial release"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_NAME/fleet-bridge.git
git push -u origin main
```

不要把访问令牌写进仓库地址或项目文件。不要通过强制添加文件绕过忽略规则。如果项目已经初始化 Git，先检查现有分支和远程地址，不要重复执行初始化或覆盖已有配置。

## 3. 发布当前版本

确认主分支测试通过、待发布修改已经提交，再创建与项目版本完全一致的标签：

```powershell
git tag v0.1.6
git push origin v0.1.6
```

发布工作流接受 `v数字.数字.数字` 格式的正式标签，并检查它是否与项目配置中的版本一致。普通主分支推送不会自动发布安装包。

在 GitHub Actions 中查看 `Release Windows` 工作流。当前流程依次执行：

1. 使用 Windows 环境和 Node.js 22 安装锁定的依赖。
2. 核对标签，运行单元测试及隔离的更新下载测试。
3. 编译应用，构建安装版与便携版，并从当前仓库信息生成更新配置。
4. 检查安装包、便携版、差分文件和更新清单是否齐全，核对安装包大小及 SHA512。
5. 生成 SHA256 校验文件，将全部发布文件上传至草稿 Release，上传成功后再公开。

工作流使用运行环境提供的 `GITHUB_REPOSITORY` 获取仓库地址，使用 `GITHUB_TOKEN` 发布文件。不需要把私人 GitHub Token 附带到程序或提交到源码中。

### 发布文件

当前版本的公开 Release 应包含：

| 文件 | 用途 |
| --- | --- |
| `Fleet-Bridge-0.1.6-Setup.exe` | Windows 安装版，支持程序内更新 |
| `Fleet-Bridge-0.1.6-Setup.exe.blockmap` | 安装版的差分下载辅助文件 |
| `Fleet-Bridge-0.1.6-Windows.exe` | Windows 便携版 |
| `latest.yml` | 安装版更新清单，包含版本与 SHA512 |
| `SHA256SUMS.txt` | 上述发布文件的 SHA256 校验值 |

不要只分发源码压缩包或单个安装文件来替代完整的更新发布。程序内更新需要同一 Release 中的更新清单及配套文件。

当前工作流不会覆盖已经公开的正式 Release。需要修正已发布内容时，应增加版本号并发布新标签。上传中断会保留草稿；排除问题后可以重新运行该标签的发布工作流。

## 4. 后续版本

先提交本次功能或修复，确保工作区干净，再增加版本并发布。例如，从 `0.1.6` 发布下一个补丁版本 `0.1.7`：

```powershell
git add .
git diff --cached --name-only
git diff --cached
git commit -m "Describe the changes"
npm version patch -m "Release %s"
git push origin main
git push origin v0.1.7
```

`npm version patch` 更新项目配置和锁文件中的版本，并创建版本提交与标签。实际版本不是上述示例时，最后推送的标签也必须改为相应版本。

推送标签前应完成该版本的测试。安装包名称和更新清单中的版本由构建流程生成，不应手工改成另一个版本。

## 5. 用户更新方式

从已配置仓库的正式安装版启动后，程序默认在约 15 秒后检查更新，运行期间每 6 小时再次检查。自动检查与自动下载都可在设置中关闭。

发现新版后，程序可以后台下载并显示进度。下载完成后由用户选择重启安装；如果还有模型请求进行中，程序会要求先结束请求，不会直接中断正在进行的调用。

便携版不执行自身替换安装，提供发布页入口。开发模式、未配置更新源的构建也不会执行安装更新。

从 `0.1.5` 或更早版本迁移时，需要先手动安装一次支持更新的版本。安装前在系统托盘中选择「退出舰桥」。应用保留已有配置与连接记录；迁移后可先确认原有服务商能够正常使用。

## 6. 本地构建发布文件

本地打包使用项目自身的发布脚本。需要生成可用的 GitHub 更新配置时，先设置实际仓库地址：

```powershell
$env:GITHUB_REPOSITORY = "YOUR_GITHUB_NAME/fleet-bridge"
npm run dist -- --require-repository
node scripts/check-release.cjs v0.1.6 --assets
```

也可以在项目配置中填写实际的 `repository.url`。脚本优先读取 `GITHUB_REPOSITORY`，未设置时再读取项目配置；示例账号只是占位符，不能直接作为正式更新源。

当前输出目录为项目下的 `release/ui-update/`。本地构建不会自动上传这些文件；正式发布由标签工作流执行。

不设置仓库地址时，普通本地打包仍可运行，但程序没有可用的 GitHub 更新源。添加 `--require-repository` 会在缺少仓库地址时停止打包，避免误发布未配置更新的版本。

只需要便携版时可运行：

```powershell
npm run dist:portable
```

仅构建便携版不会生成完整的安装版更新文件，不能替代正式发布流程。

## 7. 发布核对

- 标签必须与本次提交的项目版本一致。
- Actions 的测试、构建、发布文件核验步骤必须通过。
- Release 中应同时存在安装版、便携版、差分文件、更新清单和校验文件。
- 在安装版中确认服务商配置、模型连接和手动检查更新正常。
- 本地下载测试只验证隔离环境中的更新发现、校验与重试，不执行真实安装；正式仓库的跨版本在线升级需要另外实际验收。
- 不在源码仓库中提交本地测试产物、构建缓存或带有真实凭据的数据。
