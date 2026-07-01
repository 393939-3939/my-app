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

  const escaped = escapeHtml(value)
    .replace(/\r\n/g, "\n")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  const lines = escaped.split("\n");
  const htmlLines = [];
  let inList = false;

  for (const line of lines) {
    if (/^\s*-\s+/.test(line)) {
      if (!inList) {
        htmlLines.push("<ul>");
        inList = true;
      }
      htmlLines.push(`<li>${line.replace(/^\s*-\s+/, "")}</li>`);
      continue;
    }

    if (inList) {
      htmlLines.push("</ul>");
      inList = false;
    }

    if (line.trim()) {
      htmlLines.push(`<p>${line}</p>`);
    }
  }

  if (inList) {
    htmlLines.push("</ul>");
  }

  return htmlLines.join("");
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

async function loadTasks() {
  return prisma.task.findMany({
    orderBy: { createdAt: "desc" },
    include: { parent: true, children: true },
  });
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
  const tasks = await loadTasks();
  const theme = req.query.theme || "sky";

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

  const rootTasks = buildTaskTree(taskViewModel);

  res.render("index", { users, tasks: taskViewModel, rootTasks, theme });
});

app.get("/tree", async (req, res) => {
  const tasks = await loadTasks();
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
      },
    });
  }
  res.redirect("/");
});

app.post("/tasks/update", async (req, res) => {
  const taskId = Number(req.body.id);
  const content = req.body.content?.trim();
  const details = req.body.details?.trim();
  const progress = clampProgress(Number(req.body.progress));
  const priority = req.body.priority || "normal";
  const dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;

  if (!Number.isInteger(taskId) || !content) {
    res.status(400).send("不正なタスクです。");
    return;
  }

  await prisma.task.update({
    where: { id: taskId },
    data: {
      content,
      details: details || null,
      progress,
      priority,
      dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
    },
  });

  res.redirect("/");
});

app.post("/tasks/parent", async (req, res) => {
  const taskId = Number(req.body.id);
  const parentId = req.body.parentId ? Number(req.body.parentId) : null;

  if (!Number.isInteger(taskId)) {
    res.status(400).send("不正なタスクIDです。");
    return;
  }

  await prisma.task.update({
    where: { id: taskId },
    data: {
      parentId: Number.isInteger(parentId) ? parentId : null,
    },
  });

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
  const taskId = Number(req.body.id);
  if (!Number.isInteger(taskId)) {
    res.status(400).send("不正なタスクIDです。");
    return;
  }

  await prisma.task.delete({ where: { id: taskId } });
  res.redirect("/");
});
app.post("/theme", async (req, res) => {
  const theme = req.body.theme || "sky";
  res.redirect(`/?theme=${encodeURIComponent(theme)}`);
});
app.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で動き出したぞ。`);
});
