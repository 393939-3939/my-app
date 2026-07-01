export function clampProgress(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value / 10) * 10));
}

export function getTaskDisplayState(task, now = new Date()) {
  const dueDate = task?.dueDate ? new Date(task.dueDate) : null;
  if (!dueDate || Number.isNaN(dueDate.getTime())) {
    return { isUrgent: false, remainingSeconds: null, remainingText: null };
  }

  const remainingSeconds = Math.max(0, Math.floor((dueDate.getTime() - now.getTime()) / 1000));
  const days = Math.floor(remainingSeconds / 86400);
  const hours = Math.floor((remainingSeconds % 86400) / 3600);
  const minutes = Math.floor((remainingSeconds % 3600) / 60);
  const seconds = remainingSeconds % 60;

  return {
    isUrgent: remainingSeconds <= 21600,
    remainingSeconds,
    remainingText: `${days}日 ${hours}時間 ${minutes}分 ${seconds}秒`,
  };
}
