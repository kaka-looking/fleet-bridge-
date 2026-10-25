# 参与开发

使用 Node.js 22.12 或更新版本，安装依赖并启动：

```powershell
npm ci
npm run dev
```

提交前运行：

```powershell
npm test
npm run build
```

修改自动更新逻辑时，另运行 `npm run test:updates` 与 `npm run test:updates-ui`。修改桌面交互时，可运行 `npm run test:desktop`、`npm run test:visual`；相关测试在隔离目录中操作。

请勿在 Issue、日志附件、提交或截图中包含真实 API Key、Codex 访问令牌、私人对话和本地数据文件。提交源码、锁文件及所需资源，不提交构建产物或 `artifacts/` 下的测试数据。

发布由项目维护者推送正式版本标签触发，步骤见 [GitHub 发布说明](docs/github-release.md)。
