import "dotenv/config";
import express from "express";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { clampProgress, getTaskDisplayState } from "./lib/taskUtils.js";

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function renderMarkdown(value) {
  if (!value) return "";

  // 1. エスケープと改行コードの統一
  const escaped = escapeHtml(value).replace(/\r\n/g, "\n");

  const lines = escaped.split("\n");
  const htmlLines = [];
  let inList = false;

  for (let line of lines) {
    // --- 水平線 (---) の処理 ---
    if (/^===$|^---$|^\*\*\*$/.test(line.trim())) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      htmlLines.push("<hr class='my-4 border-slate-300' />");
      continue;
    }

    // --- 見出し (#) の処理 ---
    if (/^(#{1,6})\s+(.+)$/.test(line.trim())) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      const match = line.trim().match(/^(#{1,6})\s+(.+)$/);
      const level = match[1].length;
      const text = match[2];
      
      const sizeClass = level === 1 ? "text-xl font-bold mt-4 mb-2" : level === 2 ? "text-lg font-bold mt-3 mb-2" : "text-base font-semibold mt-2 mb-1";
      htmlLines.push(`<h${level} class="${sizeClass}">${text}</h${level}>`);
      continue;
    }

    // --- 引用 (>) の処理 ---
    if (/^\s*&gt;\s*(.*)$/.test(line)) {
      if (inList) { htmlLines.push("</ul>"); inList = false; }
      const text = line.replace(/^\s*&gt;\s*/, "");
      htmlLines.push(`<blockquote class="border-l-4 border-slate-300 pl-3 italic text-slate-500 my-2">${text}</blockquote>`);
      continue;
    }

    // --- リスト（-, *, タスクリスト）の処理 ---
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        htmlLines.push("<ul class='list-disc pl-5 my-1 space-y-0.5'>");
        inList = true;
      }
      
      let listItemContent = line.replace(/^\s*[-*]\s+/, "");
      
      if (/^\[\s\]\s/.test(listItemContent)) {
        listItemContent = listItemContent.replace(/^\[\s\]\s/, '<input type="checkbox" disabled class="mr-1.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500">');
      } else if (/^\[[xX]\]\s/.test(listItemContent)) {
        listItemContent = listItemContent.replace(/^\[[xX]\]\s/, '<input type="checkbox" checked disabled class="mr-1.5 rounded border-slate-300 text-sky-600 focus:ring-sky-500">');
      }
      
      // リスト内のテキストにもインライン装飾を適用
      listItemContent = replaceInlineElements(listItemContent);
      htmlLines.push(`<li>${listItemContent}</li>`);
      continue;
    }

    // リストが終わったタイミングで </ul> を閉じる
    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }

    // --- 通常の段落 (<p>) の処理 ---
    if (line.trim()) {
      // インライン装飾を適用して段落を追加
      htmlLines.push(`<p class="my-1">${replaceInlineElements(line)}</p>`);
    }
  }

  // ループ終了後の閉じ忘れ防止
  if (inList) htmlLines.push("</ul>");

  return htmlLines.join("");
}

// インライン要素（装飾・リンク）の一括置換用ヘルパー関数
function replaceInlineElements(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<u>$1</u>")      // 下線 (アンダーライン)
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")    // 取り消し線
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-sky-600 hover:underline" target="_blank" rel="noopener noreferrer">$1</a>');
}

const USER_ID_REGEX = /^[A-Za-z0-9]+$/;
function isValidUserId(userId) {
  return typeof userId === "string" && USER_ID_REGEX.test(userId);
}

function parseCookies(cookieHeader = "") {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [key, ...rest] = pair.split("=");
        return [decodeURIComponent(key), decodeURIComponent(rest.join("=") || "")];
      })
  );
}

function getCookie(req, name) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[name];
}

function setCookie(res, name, value, options = {}) {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.httpOnly) cookie += `; HttpOnly`;
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options.secure) cookie += `; Secure`;
  res.setHeader("Set-Cookie", cookie);
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0, path: "/" });
}

// Prisma 7 の接続設定じゃ
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter, log: ["query"] });

const app = express();
const PORT = process.env.PORT || 8888;

app.set("view engine", "ejs");
app.set("views", "./views");
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

async function loadTasks(loginUserId) {
  const findOptions = {
    orderBy: { createdAt: "desc" },
    include: { parent: true, children: true },
  };
  if (loginUserId) {
    findOptions.where = { userId: loginUserId };
  }

  return prisma.task.findMany(findOptions);
}

async function getCurrentUser(req) {
  const loginUserId = getCookie(req, "loginUserId");
  if (!isValidUserId(loginUserId)) {
    return null;
  }

  return prisma.user.findUnique({ where: { loginId: loginUserId } });
}

function buildTaskTree(tasks) {
  const nodes = tasks.map((task) => ({ ...task, children: [] }));
  const byId = new Map(nodes.map((task) => [task.id, task]));
  const roots = [];

  nodes.forEach((task) => {
    if (task.parentId && byId.has(task.parentId)) {
      const parent = byId.get(task.parentId);
      if (parent && !parent.children.some((child) => child.id === task.id)) {
        parent.children.push(task);
      }
    } else {
      roots.push(task);
    }
  });

  return roots;
}

app.get("/", async (req, res) => {
  const users = await prisma.user.findMany();
  const theme = req.query.theme || "sky";
  const loginError = String(req.query.loginError || "");
  const prefillUserId = String(req.query.prefillUserId || "");
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  const tasks = currentUserId ? await loadTasks(currentUserId) : [];

  const parentCounts = new Map();
  tasks.forEach((task) => {
    if (task.parentId) {
      parentCounts.set(task.parentId, (parentCounts.get(task.parentId) || 0) + 1);
    }
  });

  const taskViewModel = tasks
    .map((task) => {
      const displayState = getTaskDisplayState(task);
      return {
        ...task,
        isUrgent: displayState.isUrgent,
        remainingText: displayState.remainingText,
        dueDateIso: task.dueDate ? task.dueDate.toISOString() : null,
        priorityLabel: task.priority === "high" ? "高" : task.priority === "low" ? "低" : "中",
        parentCount: parentCounts.get(task.id) || 0,
        renderedDetails: renderMarkdown(task.details || ""),
      };
    })
    .sort((a, b) => b.parentCount - a.parentCount || a.createdAt - b.createdAt);

  const rootTasks = currentUserId ? buildTaskTree(taskViewModel) : [];

  res.render("index", { users, tasks: taskViewModel, rootTasks, theme, currentUserId, loginError, prefillUserId });
});

app.post("/session", async (req, res) => {
  const userId = String(req.body.userId || "").trim();
  const action = String(req.body.action || "login");

  if (!isValidUserId(userId)) {
    return res.redirect(`/?loginError=${encodeURIComponent("ユーザーIDは半角英数字のみです。")}&prefillUserId=${encodeURIComponent(userId)}`);
  }

  const existingUser = await prisma.user.findUnique({ where: { loginId: userId } });
  if (action === "register") {
    if (existingUser) {
      return res.redirect(`/?loginError=${encodeURIComponent("このユーザーIDは既に使われています。")}&prefillUserId=${encodeURIComponent(userId)}`);
    }
    await prisma.user.create({ data: { loginId: userId } });
    setCookie(res, "loginUserId", userId, { maxAge: 60 * 60 * 24 * 30, path: "/", sameSite: "Lax" });
    return res.redirect("/");
  }

  if (!existingUser) {
    return res.redirect(`/?loginError=${encodeURIComponent("ユーザーが見つかりません。新規登録してください。")}&prefillUserId=${encodeURIComponent(userId)}`);
  }

  setCookie(res, "loginUserId", userId, { maxAge: 60 * 60 * 24 * 30, path: "/", sameSite: "Lax" });
  return res.redirect("/");
});

app.post("/logout", async (req, res) => {
  clearCookie(res, "loginUserId");
  res.redirect("/");
});

app.get("/tree", async (req, res) => {
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  if (!currentUserId) {
    return res.redirect("/");
  }

  const tasks = await loadTasks(currentUserId);
  const theme = req.query.theme || "sky";

  const parentCounts = new Map();
  tasks.forEach((task) => {
    if (task.parentId) {
      parentCounts.set(task.parentId, (parentCounts.get(task.parentId) || 0) + 1);
    }
  });

  const treeTasks = tasks
    .map((task) => ({
      ...task,
      parentCount: parentCounts.get(task.id) || 0,
      children: [],
    }))
    .sort((a, b) => b.parentCount - a.parentCount || a.createdAt - b.createdAt);

  const byId = new Map(treeTasks.map((task) => [task.id, task]));
  treeTasks.forEach((task) => {
    if (task.parentId && byId.has(task.parentId)) {
      const parent = byId.get(task.parentId);
      if (!parent.children.some((child) => child.id === task.id)) {
        parent.children.push(task);
      }
    }
  });

  const roots = treeTasks.filter((task) => !task.parentId);
  res.render("tree", { tasks: roots, theme });
});

app.post("/tasks", async (req, res) => {
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  if (!currentUserId) {
    return res.status(401).send("ログインしてください。");
  }

  const content = req.body.content?.trim();
  const details = req.body.details?.trim();
  const progress = clampProgress(Number(req.body.progress));
  const priority = req.body.priority || "normal";
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
  const parentId = req.body.parentId ? Number(req.body.parentId) : null;

  if (content) {
    await prisma.task.create({
      data: {
        content,
        details: details || null,
        progress,
        priority,
        dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
        parentId: Number.isInteger(parentId) ? parentId : null,
        userId: currentUserId,
      },
    });
  }
  res.redirect("/");
});

app.post("/tasks/update", async (req, res) => {
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  const taskId = Number(req.body.id);
  const content = req.body.content?.trim();
  const details = req.body.details?.trim();
  const progress = clampProgress(Number(req.body.progress));
  const priority = req.body.priority || "normal";
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;

  if (!currentUserId || !Number.isInteger(taskId) || !content) {
    res.status(400).send("不正なタスクです。");
    return;
  }

  const result = await prisma.task.updateMany({
    where: { id: taskId, userId: currentUserId },
    data: {
      content,
      details: details || null,
      progress,
      priority,
      dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
    },
  });

  if (result.count === 0) {
    res.status(404).send("タスクが見つかりません。");
    return;
  }

  res.redirect("/");
});

app.post("/tasks/parent", async (req, res) => {
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  const taskId = Number(req.body.id);
  const parentId = req.body.parentId ? Number(req.body.parentId) : null;

  if (!currentUserId || !Number.isInteger(taskId)) {
    res.status(400).send("不正なタスクIDです。");
    return;
  }

  const result = await prisma.task.updateMany({
    where: { id: taskId, userId: currentUserId },
    data: {
      parentId: Number.isInteger(parentId) ? parentId : null,
    },
  });

  if (result.count === 0) {
    res.status(404).send("タスクが見つかりません。");
    return;
  }

  res.redirect("/");
});

// ユーザー追加ボタンが押されたときの処理
app.post("/users", async (req, res) => {
  const name = req.body.name;
  // 文字列で送られてくるので数値に変換するぞ
  const age = Number(req.body.age);

  if (isNaN(age)) {
    res.status(400).send("年齢は数値でなければなりません。");
    return;
  }

  if (name) {
    // name と age の両方を保存するよう変更
    const newUser = await prisma.user.create({ data: { name, age } });
    console.log("追加:", newUser);
  }
  res.redirect("/");
});

app.post("/tasks/delete", async (req, res) => {
  const currentUser = await getCurrentUser(req);
  const currentUserId = currentUser?.loginId || null;
  const taskId = Number(req.body.id);
  if (!currentUserId || !Number.isInteger(taskId)) {
    res.status(400).send("不正なタスクIDです。");
    return;
  }

  const result = await prisma.task.deleteMany({ where: { id: taskId, userId: currentUserId } });
  if (result.count === 0) {
    res.status(404).send("タスクが見つかりません。");
    return;
  }

  res.redirect("/");
});
app.post("/theme", async (req, res) => {
  const theme = req.body.theme || "sky";
  res.redirect(`/?theme=${encodeURIComponent(theme)}`);
});
app.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で動き出したぞ。`);
});
