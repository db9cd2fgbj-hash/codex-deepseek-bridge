# Codex DeepSeek Bridge

一个本地 DeepSeek Web 网关，把 `chat.deepseek.com` 的网页会话包装成 Codex 可用的 OpenAI Responses 兼容接口。

它提供：

- 可视化登录和状态页面
- DeepSeek Web 凭证捕获与本地保存
- `/v1/models`
- `/v1/chat/completions`
- `/v1/responses`
- 基础工具调用适配：`function_call`、`custom_tool_call`、`tool_search_call`

> 注意：这是 DeepSeek Web 的本地桥接方案，不是 DeepSeek 官方 API。工具调用依赖提示词输出 `<tool_call>` 后由网关转换成 Responses 事件，稳定性不等同于原生工具调用模型。

## 使用限制

本项目公开代码，但不是商业授权项目。

- 仅允许个人学习、研究和非商业用途。
- 未经作者书面许可，不得用于销售、付费服务、商业集成、企业或组织生产环境。
- 软件按“现状”提供，不提供任何担保。
- 因使用本项目导致的账号风险、服务限制、数据损失、法律责任或其他损失，作者不承担责任。

完整条款见 [LICENSE](./LICENSE)。

## 依赖说明

你需要准备：

- Node.js 18 或更高版本
- npm
- Chrome 或 Microsoft Edge
- 一个可登录的 DeepSeek Web 账号
- Codex Desktop / Codex CLI，并支持自定义 `model_provider`
- PoW 依赖源文件，用于读取 DeepSeek PoW WASM

安装 npm 依赖：

```powershell
npm install
```

本项目直接 npm 依赖：

```text
playwright-core
```

`node_modules/` 不会提交到仓库。克隆项目后必须自己执行 `npm install`。

## PoW 依赖怎么用

DeepSeek Web 的 PoW 计算需要读取一个 PoW 依赖源文件，并从中提取 `SHA3_WASM_B64`。

你需要自己准备这个依赖源文件，然后设置环境变量 `DEEPSEEK_POW_SOURCE_PATH` 指向它：

```text
<path-to-pow-source-file>
```

PowerShell 示例：

```powershell
$env:DEEPSEEK_POW_SOURCE_PATH="<path-to-pow-source-file>"
npm start
```

如果不设置这个环境变量，遇到 DeepSeekHashV1 PoW 时网关会报错。

PoW 依赖源文件不包含在本仓库里，请自行准备，并遵守对应项目的许可证。

## 安全提醒

不要提交或公开这些目录：

```text
.deepseek-auth/
.deepseek-browser-profile/
node_modules/
_refs/
```

`.deepseek-auth/credentials.json` 里包含 DeepSeek Web 的 cookie 和 bearer，泄露后等同于泄露登录态。

## 登录 DeepSeek

```powershell
npm run login
```

脚本会打开浏览器。登录 `chat.deepseek.com` 后，凭证会保存到：

```text
.deepseek-auth/credentials.json
```

也可以打开可视化页面后点击登录：

```powershell
npm start
```

然后访问：

```text
http://127.0.0.1:8787
```

## 启动本地网关

先设置 PoW 依赖源文件路径：

```powershell
$env:DEEPSEEK_POW_SOURCE_PATH="<path-to-pow-source-file>"
```

再启动：

```powershell
npm start
```

默认地址：

```text
http://127.0.0.1:8787/v1
```

模型名：

```text
deepseek-web/deepseek-chat
deepseek-web/deepseek-reasoner
```

## Codex 配置

```toml
model_provider = "deepseek"
model = "deepseek-web/deepseek-chat"

[model_providers.deepseek]
name = "deepseek"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
api_key = "deepseek"
```

改完配置后，建议重新打开一个 Codex 会话。

## 本地测试

普通 Responses：

```powershell
$body = @{ model="deepseek-web/deepseek-chat"; stream=$false; input="Reply exactly: ok" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/v1/responses -ContentType "application/json; charset=utf-8" -Body $body
```

可视化页面内也提供快捷测试：

- 普通对话
- Responses
- Function 工具
- Custom 工具

## 第三方组件

本项目直接依赖：

- `playwright-core`，用于连接 Chrome/Edge 并捕获 DeepSeek Web 登录凭证。

运行时还会使用：

- Chrome 或 Microsoft Edge
- DeepSeek Web
- PoW 依赖源文件中的 PoW WASM 常量
- Codex 的 Responses 兼容配置

第三方组件分别适用它们自己的许可证和服务条款。

## 许可证

本项目使用自定义非商业许可证。允许个人学习、研究和非商业使用；禁止未经授权的商业用途；不提供任何担保，作者不承担使用风险。

详见 [LICENSE](./LICENSE)。
