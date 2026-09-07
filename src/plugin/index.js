import { createMemoryTools, memoryNavText, memoryLogTurn } from './tools.js';
export const name = 'memory';
export const version = '1.3.0';
export const inject = ['tools', 'systemPrompt'];

// 让 memory 插件成为"好公民": apply() 全程容错, 任何异常都只记日志, 绝不上抛。
// 否则插件一旦在 boot/更新重启时抛错, 会连带让 DSH host 一起闪退。
export function apply(ctx) {
  // --- 工具注册: 逐条 try/catch, 单条失败仅告警, 不中断其余工具 ---
  ctx.effect(() => {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      ctx.logger?.warn?.('[memory] tools service unavailable; skipping tool registration');
      return;
    }
    let tools;
    try {
      tools = createMemoryTools();
    } catch (e) {
      ctx.logger?.warn?.('[memory] createMemoryTools failed: ' + String(e?.message || e));
      return;
    }
    let ok = 0, fail = 0;
    for (const tool of tools) {
      try {
        ctx.tools.register(tool); ok++;
      } catch (e) {
        fail++;
        ctx.logger?.warn?.('[memory] tool register failed [' + (tool && tool.name) + ']: ' + String(e?.message || e));
      }
    }
    ctx.logger?.info?.('[memory] registered ' + ok + ' memory tools (failed ' + fail + ')');
  });
  // --- memory-nav 预置: 容错 ---
  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      ctx.effect(() => {
        try {
          ctx.systemPrompt.section({
            name: 'memory:nav',
            order: 150,
            text: () => memoryNavText(),
          });
          ctx.logger?.info?.('[memory] registered memory-nav prompt section');
        } catch (e) {
          ctx.logger?.warn?.('[memory] memory-nav section failed: ' + String(e?.message || e));
        }
      });
    } else {
      ctx.logger?.warn?.('[memory] systemPrompt service unavailable; skipping memory-nav seed');
    }
  } catch (e) {
    ctx.logger?.warn?.('[memory] memory-nav setup failed: ' + String(e?.message || e));
  }
  // --- auto-log 钩子 (方案A): 注册本身与回调都容错 ---
  try {
    if (ctx.on && typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        try {
          if (!event || typeof event !== 'object' || event.type !== 'user/message') return;
          const content = event?.data?.content;
          let text = '';
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
            }
          } else if (typeof content === 'string') {
            text = content;
          }
          if (!text.trim()) return;
          // 只记真实用户输入, 跳过系统注入的 reminder/runtime context 等。
          const skip = /^Current runtime context\.|^<system-reminder>|^\[memory-nav\]/i.test(text.trim());
          if (skip) return;
          const res = memoryLogTurn(text);
          ctx.logger?.info?.('[memory] auto-logged turn: ' + JSON.stringify(res));
        } catch (e) {
          ctx.logger?.warn?.('[memory] auto-log failed: ' + String(e?.message || e));
        }
      });
      ctx.logger?.info?.('[memory] registered auto-log turn hook');
    } else {
      ctx.logger?.warn?.('[memory] ctx.on unavailable; skipping auto-log turn hook');
    }
  } catch (e) {
    ctx.logger?.warn?.('[memory] auto-log hook setup failed: ' + String(e?.message || e));
  }
}
export default { name, version, inject, apply };
