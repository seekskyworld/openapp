/** 外部插件浏览器集成测试使用的中性宿主，独立于前端生产入口。 */
import * as module0 from "../src/api.ts";
import * as module1 from "react";
import * as module2 from "react-dom/client";
import * as module3 from "../src/features/auth/LoginPage.tsx";
import * as module4 from "./react-test-harness.ts";
import * as module5 from "../src/features/auth/compat/load.ts";
import * as module6 from "../src/auth-api.ts";
import * as module7 from "../src/features/auth/useEmailAuth.ts";
import * as module8 from "../src/features/auth/WorkspaceLoginPage.tsx";
import * as module9 from "../src/features/entry/WorkspaceEntryPage.tsx";
import * as module10 from "../src/features/entry/user-entry-flow.ts";
export const apiVersion = 1;
export const modules = {
"../src/api.ts": module0,
"react": module1,
"react-dom/client": module2,
"../src/features/auth/LoginPage.tsx": module3,
"./react-test-harness.ts": module4,
"../src/features/auth/compat/load.ts": module5,
"../src/auth-api.ts": module6,
"../src/features/auth/useEmailAuth.ts": module7,
"../src/features/auth/WorkspaceLoginPage.tsx": module8,
"../src/features/entry/WorkspaceEntryPage.tsx": module9,
"../src/features/entry/user-entry-flow.ts": module10,
};
