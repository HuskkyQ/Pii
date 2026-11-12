# 设计：PC / H5 选择器分型（权限 / 模型 / 工作目录）

> 日期：2026-11-12  
> 状态：设计已确认，待写实施计划  
> 涉及前端：`web/src/App.tsx`、`web/src/components/chat/Composer.tsx`、`web/src/components/ConversationsPanel.tsx`、`PermissionPicker.tsx`、`ModelPicker.tsx`、`CwdPicker.tsx`

## 1. 背景与问题

当前 `PermissionPicker`、`ModelPicker`、`CwdPicker` 都使用同一套「底部抽屉」外框：

```tsx
<div className="fixed inset-0 z-[70]">
  <div className="absolute inset-0 bg-black/50" onClick={onClose} />
  <div className="absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col rounded-t-2xl border-t bg-background …">
    …
  </div>
</div>
```

`inset-x-0` 在手机上合适：贴近拇指、能滚动、避开底部安全区。但在 PC 上会变成**横跨整个窗口宽度的底部弹框**，和左下角那个小小的「权限」chip 完全不成比例，也不像桌面软件里常见的下拉菜单。

项目里已经有 `md = 768px` 的桌面/手机分界（会话列表：`hidden md:block` 桌面侧栏 + `md:hidden` 手机抽屉），本次沿用这个断点。

## 2. 目标与边界

### 目标

1. **≥768px（PC）**：三个选择器都变成约 360px 宽、贴住各自触发按钮的小浮层，不再出现整页宽底部弹框。
2. **<768px（H5）**：三个选择器保持现在的底部抽屉、深色遮罩、`env(safe-area-inset-bottom)` 留白。
3. 权限面板在 PC 上点预设后**保存并自动收起**；展开「高级」逐工具开关时保持打开，方便连续调整。手机端仍保留「完成」按钮，行为不变。
4. 三个面板共用一套「双端外壳」，避免遮罩、定位、Esc、断点逻辑抄三遍。

### 非目标

- 不改后端 API、权限策略、模型列表、目录浏览、保存与错误提示逻辑。
- 不重新设计三个面板内部的列表、文案、图标、开关样式。
- 不改 `ApprovalCards`、会话抽屉、状态栏、toast 等其它浮层。
- 不新增 npm 依赖。
- 不引入完整 focus trap 或第三方 popper 库。

## 3. 已确认的决策

| 项 | 决策 |
|---|---|
| 改动范围 | 权限、模型、工作目录**三个面板一起改**（用户选 2） |
| PC 样式 | 贴触发按钮的小浮层（用户选 A），不是居中 modal，也不是右侧抽屉 |
| 权限预设交互 | PC 点预设自动收起；高级开关不收起（用户选 1） |
| 实现路线 | 通用 `ResponsivePicker` 外壳 + 三个内容组件（用户选方案 1） |
| 断点 | `md = 768px`，与项目现有响应式规则一致 |
| 手机端 | 保持现状，不跟着改 |

## 4. 总体结构

### 4.1 新增 `web/src/components/ui/responsive-picker.tsx`

导出 `ResponsivePicker`。它只负责「外壳」，不关心里面是权限、模型还是目录。

```ts
interface ResponsivePickerProps {
  open: boolean;
  /** 触发按钮；桌面浮层贴它定位 */
  anchor?: HTMLElement | null;
  /** 浮层左对齐还是右对齐；默认 start */
  align?: "start" | "end";
  /** 无障碍名称 */
  label: string;
  /** 手机端各自保留原来的高度上限：权限 82dvh，模型/目录 78dvh */
  mobileMaxHeight?: string;
  onClose: () => void;
  /** 传入 isDesktop，供 PermissionPicker 决定「点预设是否自动关」 */
  children: (ctx: { isDesktop: boolean }) => React.ReactNode;
}
```

行为：

- `open === false` 时返回 `null`；三个选择器组件本身仍挂在 `App.tsx` 上，保持原有 hooks 生命周期。
- 用 `useMediaQuery("(min-width: 768px)")` 判断当前形态；窗口跨过断点时重新渲染，不保留隐藏的另一套 DOM。
- 桌面：
  - `fixed inset-0 z-[69]` 透明点击层，点它关闭；不再有整页深色遮罩。
  - 面板 `fixed z-[70]`，`w-[360px] max-w-[calc(100vw-24px)] max-h-[min(70dvh,520px)] rounded-xl border bg-background shadow-2xl`，`role="dialog" aria-modal="true" aria-label={label}`。
  - 定位常量：`WIDTH=360`、`GAP=8`、`EDGE=12`。取 `anchor.getBoundingClientRect()`：
    - `bottom = window.innerHeight - rect.top + GAP`
    - `align="start"` 时 `desiredLeft = rect.left`
    - `align="end"` 时 `desiredLeft = rect.right - WIDTH`
    - `left = Math.max(EDGE, Math.min(desiredLeft, Math.max(EDGE, window.innerWidth - WIDTH - EDGE)))`
    - 视口比 360+24 还窄时上界会被夹到 `EDGE`，配合 `max-w` 自然得到 `left = EDGE`
  - `resize` / `visualViewport.resize` 时重算位置。
  - Esc 关闭；打开后把焦点移到面板内第一个可聚焦元素；关闭后 `anchor?.focus()`。Tab 不强制困在面板里，与现有底部抽屉保持一致。
- 手机：
  - 沿用现有 `fixed inset-0 z-[70]` + `bg-black/50` 遮罩 + `absolute inset-x-0 bottom-0` 底部抽屉。
  - 保留 `rounded-t-2xl border-t`、`pb-[env(safe-area-inset-bottom)]`、`overscroll-contain`。
  - `max-h` 取 `mobileMaxHeight`，默认 `82dvh`。
- 两种形态都把 `children` 放进一个 `flex min-h-0 flex-1 flex-col` 容器，三个面板原来的「标题 / 滚动内容 / 底部按钮」结构不改。

### 4.2 新增 `web/src/hooks/useMediaQuery.ts`

```ts
export function useMediaQuery(query: string): boolean
```

用 `window.matchMedia` + `change` 事件同步布尔值，组件卸载时移除监听。Vite 客户端渲染，无需 SSR 分支。

### 4.3 锚点传递

`App.tsx` 把原来三个布尔 state 收成一个明确的联合状态，避免「哪个面板开着」和「锚点是谁」分开漂移：

```ts
type PickerKind = "model" | "cwd" | "permissions";
type OpenPicker = { kind: PickerKind; anchor: HTMLElement } | null;
const [picker, setPicker] = useState<OpenPicker>(null);
```

- `cwdTarget` 保留：新建会话后立刻选目录仍作用于新 id。
- `closePicker()` 统一 `setPicker(null)`。
- 渲染时：`open={picker?.kind === "model"}`、`anchor={picker?.kind === "model" ? picker.anchor : null}`，其余两个同理。
- `ComposerProps` 三个回调从 `() => void` 改为 `(anchor: HTMLElement) => void`；按钮里写 `onClick={(event) => onOpenPermissions(event.currentTarget)}`。
- `ConversationsPanel` 的 `onCreateWithCwd?: () => void` 改为 `onCreateWithCwd?: (anchor: HTMLElement) => void`，桌面侧栏和手机抽屉里的「📁+」都传 `event.currentTarget`。
- `createNewWithCwd(anchor)` 先接住 anchor，再 `await create()`；异步期间按钮可能重渲染：若 anchor 仍在文档中就照常定位，若已卸载则走居中兜底。

## 5. 三个面板的改造

### 5.1 `PermissionPicker.tsx`

- 外层固定框替换为 `<ResponsivePicker open anchor align="start" label="工具执行权限" mobileMaxHeight="82dvh" onClose={onClose}>`。
- 用 render prop 拿到 `isDesktop`：
  - 新增 `applyPreset(id)`：先 `await apply(PRESETS[id])`，成功且 `isDesktop` 时 `onClose()`。
  - 预设按钮改调 `applyPreset`；`toggleTool` 仍调 `apply(...)`，**不关闭**。
  - 「完成」按钮保留，桌面在高级模式下调完开关后用它关闭；也可点外部 / Esc 关闭。
- `currentPreset`、`danger`、`advanced`、`busy`、逐工具开关、`allowUnknown: false` 的安全逻辑全部不变。
- 手机端 `isDesktop === false`：点预设不自动关，仍点「完成」。

### 5.2 `ModelPicker.tsx`

- 外层替换为 `<ResponsivePicker align="end" label="切换模型" mobileMaxHeight="78dvh" …>`。
- 搜索框、provider 分组、选中态、`listModels` / `setModel`、250ms 自动聚焦、选中后 `onClose()` 全部不变。
- 因为不再同时渲染隐藏 DOM，`inputRef` 只对应真实可见的那个输入框。

### 5.3 `CwdPicker.tsx`

- 外层替换为 `<ResponsivePicker align="start" label="选择工作目录" mobileMaxHeight="78dvh" …>`。
- 路径输入、浏览、上一级 / 家目录、`getCwd` / `browseDir` / `setCwd`、「用这个目录」后 `onClose()` 全部不变。
- 从会话侧栏「📁+」触发、拿不到稳定 anchor 时，桌面走居中兜底。

## 6. 数据流与状态

```text
点击 chip / 📁+
  → 把 event.currentTarget 交给 App.setPicker({ kind, anchor })
  → ResponsivePicker 用 matchMedia 选桌面浮层或手机抽屉
  → 面板内容照旧调各自 API
  → 成功：模型 / 目录按原逻辑关闭；权限在桌面点预设时关闭
  → 失败：toast 报错，面板保持打开可重试
  → 关闭：setPicker(null)，焦点还给 anchor
```

后端接口、请求参数、`usePolicy`、SSE 快照、会话策略文件都不参与本次改动。

## 7. 边界与错误处理

| 情况 | 处理 |
|---|---|
| `anchor` 为 null、已被卸载、`getBoundingClientRect()` 全 0 | 桌面退回居中卡片（`left:50%; top:50%; translate(-50%,-50%)`），不报错 |
| 视口宽度 < 384px | 桌面分支实际不会命中；即使命中也用 `max-w-[calc(100vw-24px)]` + `left=12` |
| 打开状态下窗口跨过 768px | `useMediaQuery` 触发重渲染，浮层 ↔ 抽屉即时切换；内容 state 不拔掉重建 |
| 桌面「模型」浮层靠右 | `align="end"` + clamp，保证不超出右边界 |
| API 失败 | 维持现有 toast；不自动关闭，用户可重试 |
| 手机 PWA 安全区 / 键盘弹起 | 手机外壳完全沿用现有 `dvh` + `env(safe-area-inset-bottom)`，不引入新的 fixed 定位 |
| Esc / 点外部 | 两种形态都关闭；桌面透明层只拦点击，不改变页面视觉 |

## 8. 验证清单

1. `npm run check`：根 `tsc --noEmit` + `web` 的 `tsc -b && vite build` 通过。
2. `npm --prefix web run lint`：oxlint 通过。
3. PC（≥1280px）：
   - 三个面板都从各自按钮上方弹出，约 360px 宽；**不再出现整页宽底部弹框**。
   - 「模型」浮层右对齐且不溢出窗口。
   - 点外部、按 Esc 都能关；关闭后焦点回到原按钮。
   - 权限：点预设立刻保存并收起；展开「高级」后连续切换 4 个开关，面板不关；「完成」可关。
   - 模型：搜索框自动聚焦、选中后关闭。
   - 目录：路径输入、浏览、上一级 / 家目录、「用这个目录」都可用。
4. 手机（390×844）：
   - 三个面板仍是底部抽屉，深色遮罩、圆角、底部安全区留白正常。
   - 权限点预设不自动关，仍点「完成」。
5. 跨断点：打开面板后把窗口从 1280px 拖到 600px，再从 600px 拖回 1280px，形态正确切换且无重复 DOM、无控制台报错。
6. 会话侧栏「📁+」新建并选目录：桌面浮层出现，目录仍作用于新会话。
7. `git status` 中不出现 `.superpowers/` 演示文件：实施时把 `.superpowers/` 加进 `.gitignore`。

## 9. 风险与兜底

- **抽象层风险**：`ResponsivePicker` 是本次唯一的新公共组件。它只管外壳，不碰业务 state；三个面板内部 JSX 基本原样搬进去，出问题可单独回退某一个面板。
- **锚点生命周期**：会话切换 / 新建会话会让按钮重渲染，anchor 可能失效。定位计算放在 `useLayoutEffect` 里每次 open / resize 重取；失效就居中，不让面板消失。
- **焦点与无障碍**：不做完整 focus trap，避免引入复杂键盘逻辑；但补上 `role="dialog"`、`aria-modal`、`aria-label` 和关闭后焦点归还，保持比现状更好的可访问性。
- **样式漂移**：桌面与手机两套 class 集中在同一个文件里，三个面板不再各自复制 `fixed inset-0` 外框。

## 10. 实施附带的小改动

- 在根 `.gitignore` 增加 `.superpowers/`，避免 brainstorming visual companion 产生的 HTML 演示文件被误提交。
- 设计文档本身单独提交；业务代码改动等实施计划评审后再做。
