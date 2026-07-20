# ForgeaX Studio — forgeax-build

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **构建与打包编排器 —— 一条声明式的「recipe + validator」流水线,把各模块源码转成经校验的发布产物。**

`forgeax-build` 是为发布而组装 ForgeaX Studio 的那一层。它不是一堆零散的 shell 脚本,而是一条
显式流水线:每个源模块由各自的 **recipe** 按既定顺序转换进 `output/` 树,随后这棵树要通过一串
**fail-closed(失败即停)的 validator**。构建绝不会对一棵装不上、类型不过、起不来的树宣告成功。

## 它为何重要

可复现的打包,是多数项目积累隐性、不可测胶水代码的地方。ForgeaX 让**构建本身**可读且有闸门:

- **声明式源清单。** `config/sources.yaml` 列出每个模块、转换它的 recipe、以及目标——一模块
  一条,按应用顺序排列。流水线读取它,而非把这些写死在代码里。
- **一模块一 recipe。** `recipes/*.ts`(`server`、`interface`、`cli`、`engine`、`harness`)各自
  负责单一的「源 → 输出」转换。新增或修改某模块的发布方式是一处局部改动,而非在巨石里全局扫荡。
- **起闸门作用、而非装饰的 validator。** `validators/` 按序运行,每步必须通过:`01-deps`(在
  `output/` 里真实安装依赖)、`02-types`(`tsc --noEmit`)、`03-smoke`(启动 server 并打它的
  健康端点)。任一红灯都会中止发布。
- **可直接启动的开发源。** `engine-src/` 以**真实文件**形式携带轻量预览运行时,因此开发模式可以
  直接从它启动 Vite,无需先跑构建流水线——这与发布 recipe 拷进产物的是同一份源。

## 架构

```
config/sources.yaml   # 模块清单(模块 → recipe → 目标),按应用顺序
recipes/*.ts          # 每个模块一条「源→输出」转换
validators/*.ts       # 有序、fail-closed 的构建后检查(deps → types → smoke)
scripts/orchestrate.ts# 读取 sources.yaml 并按序运行 recipe
scripts/validate.ts   # 按序运行 validator
engine-src/           # 可直接启动的预览运行时(真实文件,发布时也会拷贝)
build.sh              # bash → bun 入口
workspace/  output/   # 临时(gitignored):暂存区 + 最终产物
```

编排器刻意分两阶段——**组装**再**校验**——这样某个坏掉的模块会在它破坏的那道闸门处暴露,并指出
失败的具体检查。

## 用法

```bash
./build.sh release-source     # 在 output/ 产出组装好的产物
./build.sh validate           # 对 output/ 运行 validator 链
./build.sh clean              # rm -rf workspace/ output/
bun run sync-upstream         # 刷新被 vendored 的模块快照(默认 dry-run)
```

## 它如何融入 studio

studio 的开发启动器直接启动 `engine-src/` 以获得即时预览;发布路径用同一套 recipe 产出经校验的
产物。因为「组装」与「校验」都是显式且有序的,一次发布是可复现、可证明能启动的,而不是
「在我机器上能跑」。

---

本仓是 **ForgeaX Studio** 的一个子模块,隶属
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) ——
用 `--recurse-submodules` 克隆超级仓即可运行完整 studio。许可:Apache-2.0。
