import { saveModelConfigSchema } from "@loopmarshal/protocol";
import { z } from "zod";
import { action, empty, text } from "./action.js";

export const modelActions = [
  action(
    "model.list",
    "列出已配置的模型及 hasApiKey，不返回密钥明文。",
    empty,
    (c) => c.listModels(),
  ),
  action(
    "model.save",
    "新增或更新模型；同 id 更新时保留未提供的密钥。apiKey=null 或空字符串可清除密钥。敏感参数建议从文件或标准输入提供。",
    saveModelConfigSchema,
    (c, i) => c.createModel(i),
    false,
  ),
  action(
    "model.delete",
    "删除指定模型配置。",
    z.object({ id: text }).strict(),
    (c, i) => c.deleteModel(i.id),
    false,
  ),
];
