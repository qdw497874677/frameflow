---
id: "006"
title: 叠卡与滑动手势的可借鉴开源实现
labels: [wayfinder:research]
status: closed
assignee: "qdw"
blocked-by: []
---

## Question

模式 A（Tinder 式挑片流）的叠卡观感被用户判为「不真实」。在自研与整体采用开源之间怎么选？需要弄清：

- 有哪些成熟开源实现（库/组件）覆盖「跟手拖动 + 牌堆叠放 + 飞出/回弹」？
- 它们的许可证、维护活跃度、移动端手感、能否承载本产品的自定义手势（下滑选星）与「每张按自身横竖比占满取景框」的布局？
- 真实感的核心机制是什么（哪一部分是必须自研、哪一部分可以直接抄参数模型）？

产物：`wayfinder/research/006-swipe-stack-options.md`

## Resolution

三条路线，结论是**现阶段抄模型不换库**：

1. **Swiper `effect:'cards'`**（MIT、维护活跃、移动端生产级）：参数 `slideShadows / rotate / perSlideRotate(默认 2°) / perSlideOffset(默认 8px)`；实现是按 activeIndex 给每张 slide 累加位移+旋转+阴影的**2D 扇形牌堆**。优点是跟手/惯性/键盘/无障碍/虚拟幻灯片全现成；代价是触摸层被它接管，自定义下滑选星与「照片优先、各自横竖比」布局要额外适配。
2. **Swing（gajus/swing，BSD-3）**：同类里参数模型最完整——`throwOutConfidence` 0..1 阈值、`maxRotation 20°`、`throwOutDistance` 随机 450–500px、`allowedDirections`、`throwin` 弹簧回位；但周下载约 2.2K、无 TS 类型、活跃度低 → 抄模型，不引依赖。
3. **react-tinder-card / @use-gesture + framer-motion**：真实感最强的弹簧物理路线，但绑定 React → 交给票 005（技术栈）一并权衡。

**真实感的三条机制**（本产品必须自己保证，库只能提供其一）：①拖动进度与后排卡变换连续耦合（后排随拖动实时上浮/放大，不是松手才动）；②松手用速度参与的弹簧积分，而非 CSS `ease-out`；③顶卡飞出与后排顶上的曲线连续（避免「突然变亮 / 突然出现信息」）。

**决策**：把手写叠卡按 Swing 的参数模型升级（拖动耦合 + 弹簧松手 + 交接曲线），不整体换 Swiper；若后续不想维护手势层，再以 Swiper 作为 B 计划。
