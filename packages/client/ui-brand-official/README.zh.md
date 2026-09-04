# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

仅当 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，本包才用纯文本 `Vortex Harness` 填充 `sidebar.brand.name`。其他构建仍会加载 plugin，但不注册 occupant，因此显示 shell fallback。

该 occupant 通过 `slots.inject()` 安装，因此无论其条目先于还是后于侧边栏声明方激活，它都能工作，并会在声明折叠时撤回。它不保留运行时状态。node 半边是空的 Loader seat；浏览器标题仍属于本包之外的构建环境事项。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **本包只提供一个名称 occupant** —— 其他呈现应由占用相同 slot 的另一个 Cordis 包提供。
- **浏览器标题相互独立** —— `DSH_CLIENT_TITLE` 在构建期选择标题文字，而不经过 UI slot。
