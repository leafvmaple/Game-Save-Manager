# Game Save Manager 重构计划

## 项目分析报告

### 项目概况
**Game Save Manager** 是一个基于 Electron + TypeScript 的游戏存档管理工具，支持多个游戏平台（Steam、Ubisoft、EA、Epic、GOG、Xbox、Battle.net）的存档备份、恢复和导出功能。

### 当前架构分析

#### 技术栈
- **前端**: Electron + HTML/CSS + Vanilla JavaScript
- **后端**: Node.js + TypeScript (主进程)
- **数据库**: SQLite3
- **样式**: Tailwind CSS
- **国际化**: i18next

#### 项目结构问题

1. **混合架构** 🔴
   - 主进程使用 TypeScript
   - 渲染进程使用原生 JavaScript（无类型安全）
   - 缺少统一的前端框架

2. **代码组织** 🟡
   - 主进程文件职责不够清晰（`main.ts` 330行，包含太多 IPC 处理）
   - `global.ts` 成为"万能文件"（447行），包含窗口管理、工具函数、设置管理等多种职责
   - `gameData.ts` 混合了接口定义和类实现
   - `backup.ts` 文件过大（601行）

3. **类型系统** 🟡
   - TypeScript 严格模式全部关闭（tsconfig.json）
   - 接口定义分散在多个文件
   - 缺少统一的类型定义文件

4. **代码质量** 🟡
   - 缺少单元测试
   - 缺少代码规范检查配置（已安装 ESLint 但未配置）
   - 错误处理不统一
   - 大量使用 `any` 类型

5. **依赖管理** 🟢
   - 使用了现代的依赖包
   - 但混用了 `fs` 和 `original-fs`、`fs-extra`

6. **国际化** 🟢
   - 已实现 i18next 国际化
   - 支持中英文

---

## 🔧 重构计划

### 阶段一：基础架构优化（优先级：高）

#### 1.1 TypeScript 配置强化
- [x] 启用 TypeScript 严格模式（部分完成：已启用 noImplicitAny, strictFunctionTypes 等）
- [x] 统一类型定义文件结构
- [x] 创建 `src/types/` 目录统一管理接口和类型

**完成日期**: 2025-10-13  
**详细报告**: 查看 [typescript-refactor-report.md](./typescript-refactor-report.md)

#### 1.2 代码组织重构
- [ ] **主进程模块化**
  - 将 `main.ts` 的 IPC 处理器拆分到独立的控制器文件
  - 创建 `src/main/controllers/` 目录
  - 按功能分离：`gameController.ts`、`backupController.ts`、`settingsController.ts`

- [ ] **拆解 global.ts**
  - 窗口管理 → `src/main/services/windowService.ts`
  - 设置管理 → `src/main/services/settingsService.ts`
  - 工具函数 → `src/main/utils/fileUtils.ts`、`notificationUtils.ts`

- [ ] **服务层抽象**
  - 创建 `src/main/services/` 目录
  - `DatabaseService` - 数据库操作封装
  - `GameDetectionService` - 游戏检测逻辑
  - `BackupService` - 备份核心逻辑
  - `RestoreService` - 恢复核心逻辑

#### 1.3 类型系统完善
```typescript
// 建议的类型文件结构
src/types/
├── common.d.ts          // 通用类型
├── game.d.ts            // 游戏相关类型
├── backup.d.ts          // 备份相关类型
├── settings.d.ts        // 设置相关类型
├── ipc.d.ts             // IPC 通信类型
└── platform.d.ts        // 平台相关类型
```

### 阶段二：前端现代化（优先级：高）

#### 2.1 渲染进程 TypeScript 迁移
- [ ] 将所有 `src/renderer/js/*.js` 迁移到 TypeScript
- [ ] 配置 Webpack 或 Vite 进行前端打包
- [ ] 使用 ES6 模块系统替代全局函数

#### 2.2 前端框架引入（可选）
**选项 A：轻量级改造**
- 使用 Alpine.js 或 Petite-vue 渐进式升级
- 保持现有 HTML 结构

**选项 B：完整重构**
- 迁移到 Vue 3 + Vite
- 使用 Composition API
- 更好的类型支持

#### 2.3 状态管理优化
- [ ] 实现统一的状态管理（Pinia 或自定义）
- [ ] 避免直接操作 DOM
- [ ] 使用响应式数据流

### 阶段三：代码质量提升（优先级：中）

#### 3.1 测试框架搭建
- [ ] 集成 Vitest 或 Jest
- [ ] 为核心业务逻辑编写单元测试
- [ ] 为主进程和渲染进程编写集成测试
- [ ] 目标覆盖率：60%+

#### 3.2 ESLint 和 Prettier 配置
- [ ] 配置 ESLint 规则（已安装但未配置）
- [ ] 统一代码风格
- [ ] 添加 Git hooks（Husky + lint-staged）

#### 3.3 错误处理标准化
- [ ] 创建统一的错误处理中间件
- [ ] 实现错误日志系统
- [ ] 用户友好的错误提示

### 阶段四：性能和体验优化（优先级：中）

#### 4.1 性能优化
- [ ] 游戏扫描使用 Worker 线程
- [ ] 大文件备份使用流式处理
- [ ] 实现备份进度的精确显示
- [ ] 数据库查询优化（添加索引）

#### 4.2 用户体验改进
- [ ] 添加备份计划（定时备份）
- [ ] 云同步功能（可选）
- [ ] 备份压缩选项
- [ ] 备份对比功能

#### 4.3 UI/UX 改进
- [ ] 使用 UI 组件库（如 shadcn-ui 或 DaisyUI）
- [ ] 暗黑模式完善
- [ ] 响应式布局优化
- [ ] 添加加载骨架屏

### 阶段五：工程化完善（优先级：低）

#### 5.1 构建优化
- [ ] 配置多环境构建（dev/staging/prod）
- [ ] 代码分割和懒加载
- [ ] 资源压缩优化
- [ ] 自动化版本管理

#### 5.2 文档完善
- [ ] 添加 API 文档（TSDoc）
- [ ] 架构设计文档
- [ ] 贡献指南
- [ ] 开发环境搭建文档

#### 5.3 CI/CD
- [ ] GitHub Actions 自动化测试
- [ ] 自动化构建和发布
- [ ] 代码质量门禁

### 阶段六：功能扩展（优先级：低）

#### 6.1 跨平台支持
- [ ] macOS 支持（当前仅 Windows）
- [ ] Linux 支持

#### 6.2 高级功能
- [ ] 备份加密
- [ ] 备份差异化（增量备份）
- [ ] 多用户账户管理
- [ ] 插件系统

---

## 📋 重构实施建议

### 分阶段执行策略

**第 1-2 周：基础架构（阶段一）**
- 重点：类型系统、代码组织
- 目标：建立清晰的架构基础

**第 3-4 周：前端重构（阶段二）**
- 重点：TypeScript 迁移、状态管理
- 目标：前端代码可维护性提升

**第 5-6 周：质量保障（阶段三）**
- 重点：测试、代码规范
- 目标：建立质量保障体系

**第 7+ 周：持续优化（阶段四-六）**
- 重点：性能、体验、功能
- 目标：产品竞争力提升

### 风险控制

1. **向后兼容**：确保用户数据和配置迁移
2. **渐进式重构**：不一次性重写所有代码
3. **充分测试**：每个阶段完成后进行完整测试
4. **版本控制**：使用 Git 分支管理重构进度

### 关键指标

- **代码质量**：TypeScript 覆盖率 100%
- **测试覆盖**：单元测试覆盖率 60%+
- **性能**：启动时间 < 3s，扫描速度提升 50%
- **可维护性**：单文件行数 < 300 行

---

## 📝 变更日志

### 2025-10-13
- 初始版本：完成项目分析和重构计划制定
- 识别出 6 个主要问题领域
- 制定 6 个阶段的重构计划

---

## 📚 参考资料

### 架构设计
- [Electron 最佳实践](https://www.electronjs.org/docs/latest/tutorial/security)
- [TypeScript 深入理解](https://www.typescriptlang.org/docs/)
- [Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)

### 测试
- [Vitest 文档](https://vitest.dev/)
- [Electron 测试策略](https://www.electronjs.org/docs/latest/tutorial/testing)

### 代码规范
- [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript)
- [TypeScript ESLint](https://typescript-eslint.io/)

---

**注意**：本重构计划是基于 2025 年 10 月 13 日的代码库分析制定，随着项目发展可能需要调整。建议定期回顾和更新此文档。
