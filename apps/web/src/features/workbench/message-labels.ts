export const messageTypeLabels: Record<string, string> = {
  instruction: "指令",
  task: "任务",
  result: "回报",
  progress: "进度",
  system: "系统",
  error: "异常",
  ack: "确认",
  heartbeat: "连接活动",
};
export const processingLabels: Record<string, string> = {
  pending: "待接收",
  claimed: "处理中",
  processed: "已处理",
  failed: "处理失败",
};
