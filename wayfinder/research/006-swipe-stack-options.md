# 叠卡 / 滑动手势：可借鉴的开源实现（票 006 研究笔记）

问题：模式 A（Tinder 式挑片流）用手写叠卡实现，用户反馈「叠加效果不真实，各种问题」。有没有成熟开源方案可以整体借鉴或直接采用？

## 候选与实测事实

### 1. Swiper（nolimits4web/swiper）
- 许可证 MIT；库无关（vanilla JS）；tree-shakeable；仓库与类型定义活跃（npm 上已到 v14）。
- 定位：移动优先触摸滑块，「1:1 touch movement」默认开，键盘控制、A11y、虚拟幻灯片（virtual slides）、图片懒加载、RTL 一等公民。
- 叠卡能力来自模块 `effect: 'cards'`，参数（`src/types/modules/effect-cards.d.ts`）：
  - `slideShadows: boolean`（默认 true）
  - `rotate: boolean`（默认 true）
  - `perSlideRotate: number`（默认 2°，每张相差的旋转角）
  - `perSlideOffset: number`（默认 8px，每张的位移偏移）
- 效果实现模型（`src/modules/effect-cards/effect-cards.mjs`）：`setTranslate()` 遍历 `slides`，按 `activeIndex` 距离给每张 slide 施加 `translate`（perSlideOffset 累加）+ `rotate`（perSlideRotate 累加）+ 阴影，属于**2D 扇形牌堆**，不是透视纵深堆叠。
- 代价：跟手/惯性/边界/翻页全归它的触摸层；要往里塞自定义「下滑选星」手势需挂 `swiper.on('touchMove')` 或用容器外的手势层（中等摩擦）；幻灯尺寸受容器与 effect 假设约束，我们「每张按自己横竖比占满取景框」的模型需要额外适配。

### 2. Swing（gajus/swing）
- 许可证 BSD-3；专做 Tinder 式牌堆；npm 周下载约 2.2K；无 TS 类型；v3.1.4，活跃度低（近年无实质更新）。
- 但它的**配置模型是同类里最完整、最值得抄的**：
  - `throwOutConfidence(xOffset, yOffset, element)` → 0..1 的「扔出完成度」（默认按位移/元素尺寸计算，取横竖较大者）
  - `isThrowOut(...)` 在 `dragend` 判定是否扔出（默认 confidence 到 1 才算）
  - `allowedDirections: [DOWN, LEFT, RIGHT, UP]`
  - `rotation`（默认与横竖位移成比例）与 `maxRotation`（默认 20°）
  - `minThrowOutDistance 450` / `maxThrowOutDistance 500`（扔出距离取区间随机）
  - 事件：`dragstart / dragmove / dragend / throwout / throwin`，其中 **`throwin` = 「带弹簧回位效果」弹回牌堆**
  - 程序化：`throwOutCard(el, down)`、`destroyCard(el)`
- 结论：它把「跟手 → 阈值 → 回弹（弹簧）→ 扔出」这条链路定义清楚了，**可以直接照着这套参数模型改我们的手写实现**。

### 3. react-tinder-card（3DJakob）
- React 封装，物理感依赖 React 生态（react-spring 一系）。仅当产品栈定为 React（见票 005）时相关；不适合现在的 vanilla 原型。

## 分析：真实感到底来自哪里

不在「叠了几张卡 + 阴影」，而在三件事：

1. **拖动进度与后排卡变换连续耦合**：后排（下一张）应随拖动距离实时上浮/放大/回正，而不是松手那一刻才动。缺少这段耦合，就会「拖的时候后面是死的，松手突然变」= 不真实。
2. **松手用弹簧物理（速度参与）**：带初速度的 spring 积分，回弹与飞出都有惯性；CSS `ease-out` 永远是「按时间走完」，手感发木。
3. **交接曲线一致**：顶卡飞出时，后排顶上来的曲线必须与拖动时的耦合方向连续（否则出现「突然跳亮/突然出现信息」——本原型已修过一版）。

## 建议

- **现阶段**：整体换库不划算（Swiper 的 cards 是 2D 扇形，且会接管我们已打磨的自定义手势与照片优先尺寸模型）。改为**把 Swing 的参数模型搬进现有实现**：拖动进度 → 后排插值（scale/translate/亮度）+ 松手弹簧（速度参与）+ 交接曲线对齐。
- **何时换 Swiper**：如果我们不想长期维护手势/物理代码，且接受它的扇形观感与手势层约束，可作为 B 计划；届时用 `effect:'cards'` + `perSlideOffset/perSlideRotate/slideShadows` 起步。
- **产品栈若选 React**（票 005）：`react-tinder-card` 或 `@use-gesture` + `framer-motion` 弹簧是同类真实感最强的组合，值得在那张票里一并权衡。

## 来源

- Swiper 仓库与 README（MIT、移动优先、1:1 跟手、tree-shakeable、虚拟幻灯片、A11y）：https://github.com/nolimits4web/swiper
- Swiper `CardsEffectOptions` 类型定义（slideShadows / rotate / perSlideRotate / perSlideOffset 及默认值）：https://cdn.jsdelivr.net/npm/swiper@14.0.6/modules/effect-cards/effect-cards.d.ts
- Swiper cards 效果实现（`setTranslate` 遍历 slides 施加位移/旋转）：https://github.com/nolimits4web/swiper/blob/master/src/modules/effect-cards/effect-cards.mjs
- Swing README（throwOutConfidence / rotation / maxRotation / throwOutDistance / throwin 弹簧回位 / 事件对象）：https://github.com/gajus/swing
- Swing npm 元数据（BSD-3-Clause、周下载约 2.2K、无类型）：https://www.npmjs.com/package/swing
- react-tinder-card：https://github.com/3DJakob/react-tinder-card
