# Adapter 浏览器扩展参考

本文描述当前 authUi API 1。后端 Adapter manifest API v2、contracts 0.2.x 与浏览器 API 1 是不同版本轴。先阅读 [开发入口](adapter-development.md)；具体页面位置见 [源码对照](adapter-source-map.md)。

## 可扩展的范围

| 扩展                                 | 作用                                       | 不负责                                          |
| ------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| `views.workspace`                    | 应用普通用户登录页的布局、图标、表单和交互 | 实例归属、会话授权、登录后的调度                |
| `views.control`                      | 管理登录页中的应用 SSO 按钮及登录面板      | 左侧 OpenApp 品牌、本地管理员登录、整个管理后台 |
| manifest / Provider presentation     | 应用名称、描述、基础字段、挑战类型等声明   | 任意组件或可执行脚本注入                        |
| `manifest.build.packageRequirements` | 通用管理表单的包槽位、扩展名、大小和必需性 | 自定义后台页面；具体构建执行由后端策略提供      |

当前没有任意管理菜单、路由或面板注入 API。多个 Adapter 可以同时组合，但浏览器按当前入口的 Provider 或配置默认值选择登录模块，不自动生成一个全局多 Provider 选择器。

## 注册和文件布局

Adapter 的 package.json 增加以下声明，并把 assets 加入 npm files：

```json
{
  "openapp": {
    "authUi": { "apiVersion": 1, "providerId": "sample-auth", "module": "auth-ui.mjs" }
  }
}
```

模块放在 `assets/auth-ui.mjs`；module 是文件名，不是外部 URL。Provider ID 必须与后端 authProvider.id、manifest.auth.providerId 一致，App ID 可以不同。声明 UI 不会自动注册后端 Provider。

导出器将静态文件复制到 `/adapter-assets/<adapterId>/`，生成 `/auth-adapters.json`，其中 schemaVersion 为 1，providers 将 Provider ID 映射为模块路径。清单由组合流程生成，不在浏览器自行拼接或从数据库加载代码。JS、CSS、图片使用相对模块 URL，例如 `new URL('./login.css', import.meta.url).href`。

## 工厂与宿主

```js
export const apiVersion = 1;
export function createAuthUi({ React, request, ApiError }) {
  // 返回两个 React 组件；完整可交互实现见 email-code-ui 示例。
  return { views: { workspace: WorkspaceLogin, control: ControlLogin } };
}
```

上面仅展示工厂形状，WorkspaceLogin 和 ControlLogin 需要自行实现。可直接复制 [email-code-ui](../examples/email-code-ui/README.md) 的 assets；该示例是浏览器模板，不包含身份服务或完整后端 Adapter。

| 参数                      | 合同                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| host.React                | 使用宿主注入的 React 创建组件和 Hook；不随插件打包第二份 React                                                          |
| host.request(path, init?) | 返回解析后的 JSON；自动携带 credentials=include，非 FormData 请求体自动设置 JSON Content-Type；body 仍需 JSON.stringify |
| host.ApiError             | `new ApiError(status, code, requestId?)`；属性 status/code/requestId 用于安全错误映射和定位                             |
| props.locale              | `en` 或 `zh-CN`；Adapter 维护自身文案                                                                                   |
| props.onLogin(user)       | 认证成功后传入服务器返回的 PortalUser；由 Core 更新会话并导航                                                           |
| props.initialError        | 可选 unknown；只能显示经过识别的公开错误，不直接输出任意对象                                                            |

PortalUser 是 Core 会话 API 返回的用户对象。UI 不应伪造身份、角色或凭据。两种视图使用同一认证逻辑时可共享 Hook，但分别维护布局。公开类型来自 `@openapp/contracts/ui`，例如 `AuthUiLoginProps` 和 `AuthUiFactory<typeof React, React.ComponentType<AuthUiLoginProps>>`；第三方模块不导入 Core 私有 TS 文件。后端 SDK 不依赖 React，浏览器模块使用调用方的 React 类型和宿主注入实例。

request 对非 2xx 响应抛出 ApiError，code 来自响应 error/message；网络异常（包括 fetch abort）映射为 status=0、network_unavailable，成功响应的非法 JSON 为 invalid_server_response。撤销请求不能只依赖错误码；用 AbortSignal 加请求代次判断，避免旧响应覆盖新邮箱的挑战状态。

## 认证 HTTP 流程

| 请求                                            | 输入                                 | 成功结果 / 用途                                        |
| ----------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `GET /api/auth/methods`                         | 无                                   | 本地/外部认证方法及当前配置                            |
| `GET /api/entry/manifest`                       | 无                                   | 当前应用入口声明、字段和能力                           |
| `POST /api/auth/external/:provider/email-codes` | `{ "email": "member@example.test" }` | `{ ok: true, providerData?, isNewUser? }`              |
| `POST /api/auth/external/:provider/login`       | `{ email, code, providerData? }`     | `{ user, isNewUser, provider }`，服务端设置会话 Cookie |
| `GET /api/auth/session`                         | 会话 Cookie                          | authenticated/status，以及已登录时的 user              |

先成功发送验证码，再进入验证码面板；失败时保留邮箱并显示公开错误。额外注册字段以 Provider 返回的 providerData 或公开补填错误为准，不能只根据 isNewUser 决定所有字段。现代登录把额外值嵌套在 providerData，不放到请求顶层。验证码格式和长度由身份服务合同决定，不通用假定为六位数字。

成功登录只调用 onLogin(response.user)。下游 credentialGrant、访问令牌及刷新令牌留在后端；不要存入 localStorage 或把认证服务的原始响应暴露给浏览器。管理员角色由 Core 决定，SSO 成功不代表管理员授权。未注册或不属于当前 App 的 Provider 返回 404 auth_provider_not_found。

## 现代与历史模式

generic 模式调用 createAuthUi，只读取 views，不读取旧字段投影或路由实现。显式 legacy 模式调用 createAuthCompatibility；同时支持两种模式的模块应分别导出两种工厂并回归测试。仅提供旧工厂的模块在 generic 模式使用通用登录视图。

清单 404 或未找到所选 Provider 时没有 UI 扩展；非法 schema、模块路径或不支持的 apiVersion 会报错。不要把非法模块当成成功加载。允许的模块路径受限为 `/adapter-assets/<id>/<name>.mjs`。

## 安全、测试和交付

模块是经审核的同源代码，并非沙箱插件。它可以使用浏览器能力，必须纳入与前端相同的安全审查。禁止嵌入密钥、动态执行上游字符串、插入未过滤 HTML 或通过样式覆盖平台品牌。CSS 应限定在自己的根 class 下，输入具备 label、键盘操作、加载状态和可访问错误提示。

测试真实模块的两套视图：发送成功/失败、已注册账号、补充字段、错误码、重发、修改邮箱、重复提交及过期响应。示例测试位于 [adapter-ui-example.test.ts](../frontend/tests/adapter-ui-example.test.ts)。只模拟 HTTP 边界，不以测试账号替代服务器权限验证。

修改 assets 后重新组合、校验并部署前端镜像；后端合同或 Provider 同时变化时，发布匹配的后端。参考 [组合编译](composition-release.md) 与 [后端参考](adapter-backend.md)。
