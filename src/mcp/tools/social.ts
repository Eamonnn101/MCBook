/**
 * Social MCP Tools - Agent 间社交工具
 *
 * 提供聊天、交易、团队、路标等社交交互能力。
 * 这些工具由 AI 通过计划调用，不需要直接的 Bot 实例访问。
 */

import { z } from 'zod';
import { agentRegistry } from '../../multi/agentRegistry.js';
import { agentEventBus, setWaypoint, getAllWaypoints, formTeam, leaveTeam, getAgentTeams } from '../../multi/eventBus.js';
import { createTradeProposal, acceptTrade, rejectTrade, getPendingTradesFor } from '../../social/tradeEngine.js';
import { skillLibrary } from '../../skills/skillLibrary.js';

export const socialToolSchemas = {
  send_chat: {
    description: '发送定向聊天消息给另一个 Agent 或广播。target 留空则广播',
    inputSchema: z.object({
      target: z.string().optional().describe('目标 Agent 名称，留空则广播'),
      message: z.string().describe('消息内容'),
    }),
  },
  query_agent_status: {
    description: '查询另一个 Agent 的公开状态（位置、血量、人格类型等）',
    inputSchema: z.object({
      agent_name: z.string().describe('要查询的 Agent 名称'),
    }),
  },
  request_trade: {
    description: '向另一个 Agent 发起交易提案。对方会在下一个认知周期看到并决定是否接受',
    inputSchema: z.object({
      target: z.string().describe('交易对象名称'),
      offer_items: z.array(z.object({
        name: z.string(),
        count: z.number(),
      })).describe('你愿意给出的物品'),
      want_items: z.array(z.object({
        name: z.string(),
        count: z.number(),
      })).describe('你想要的物品'),
    }),
  },
  accept_trade: {
    description: '接受一个待处理的交易提案',
    inputSchema: z.object({
      trade_id: z.string().describe('交易 ID'),
    }),
  },
  reject_trade: {
    description: '拒绝一个待处理的交易提案',
    inputSchema: z.object({
      trade_id: z.string().describe('交易 ID'),
    }),
  },
  get_pending_trades: {
    description: '查看你当前的待处理交易提案',
    inputSchema: z.object({}),
  },
  form_team: {
    description: '创建一个临时团队用于协作任务',
    inputSchema: z.object({
      team_name: z.string().describe('团队名称'),
      members: z.array(z.string()).describe('团队成员名称列表'),
    }),
  },
  leave_team: {
    description: '离开当前所在的团队',
    inputSchema: z.object({
      team_name: z.string().describe('要离开的团队名称'),
    }),
  },
  set_waypoint: {
    description: '设置一个共享路标，其他 Agent 可以查看和导航',
    inputSchema: z.object({
      name: z.string().describe('路标名称'),
      x: z.number(),
      y: z.number(),
      z: z.number(),
    }),
  },
  get_waypoints: {
    description: '查看所有共享路标',
    inputSchema: z.object({}),
  },
  share_skill: {
    description: '将你的一个私有技能分享给另一个 Agent',
    inputSchema: z.object({
      skill_name: z.string().describe('要分享的技能名称'),
      target: z.string().describe('目标 Agent 名称'),
    }),
  },
  get_social_summary: {
    description: '查看你与其他 Agent 的社交关系摘要',
    inputSchema: z.object({}),
  },
} as const;

/** 社交工具名集合，供 planExecutor 白名单使用 */
export const SOCIAL_TOOL_NAMES = new Set(Object.keys(socialToolSchemas));

/** 社交工具别名映射，供 planExecutor 模糊匹配使用 */
export const SOCIAL_TOOL_ALIASES: Record<string, string> = {
  trade: 'request_trade',
  propose_trade: 'request_trade',
  trade_request: 'request_trade',
  whisper: 'send_chat',
  talk: 'send_chat',
  msg: 'send_chat',
  query_status: 'query_agent_status',
  check_agent: 'query_agent_status',
  create_team: 'form_team',
  join_team: 'form_team',
  add_waypoint: 'set_waypoint',
  mark_location: 'set_waypoint',
  list_waypoints: 'get_waypoints',
  pending_trades: 'get_pending_trades',
  view_trades: 'get_pending_trades',
  decline_trade: 'reject_trade',
  refuse_trade: 'reject_trade',
  give_skill: 'share_skill',
  teach_skill: 'share_skill',
};

/**
 * 执行社交工具（不需要 Bot 实例，在 Game Master 进程中直接运行）
 * @param callerName - 调用者 Agent 名称
 * @param tool - 工具名
 * @param args - 参数
 * @returns 结果文本
 */
export async function executeSocialTool(
  callerName: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case 'send_chat': {
      const target = args.target as string | undefined;
      const message = args.message as string;
      agentEventBus.publish({
        type: 'agent:chat',
        from: callerName,
        target: target ?? null,
        message,
        ts: Date.now(),
      });
      return target
        ? `已向 ${target} 发送消息: "${message}"`
        : `已广播消息: "${message}"`;
    }

    case 'query_agent_status': {
      const agentName = args.agent_name as string;
      const profile = agentRegistry.getPublicProfile(agentName);
      if (!profile) return `未找到 Agent: ${agentName}`;
      return JSON.stringify(profile, null, 0);
    }

    case 'request_trade': {
      const target = args.target as string;
      const offerItems = args.offer_items as Array<{ name: string; count: number }>;
      const wantItems = args.want_items as Array<{ name: string; count: number }>;

      if (!agentRegistry.get(target)) return `未找到 Agent: ${target}`;

      const proposal = createTradeProposal(callerName, target, offerItems, wantItems);
      const offerStr = offerItems.map(i => `${i.name}x${i.count}`).join(', ');
      const wantStr = wantItems.map(i => `${i.name}x${i.count}`).join(', ');
      return `交易提案已发送给 ${target} (ID: ${proposal.id})。提供: ${offerStr}，想要: ${wantStr}。等待对方回应。`;
    }

    case 'accept_trade': {
      const tradeId = args.trade_id as string;
      const trade = acceptTrade(tradeId, callerName);
      if (!trade) return `交易 ${tradeId} 不存在、已过期或不是你的交易`;
      return `已接受交易 ${tradeId}。交易将在双方下次行动时执行。`;
    }

    case 'reject_trade': {
      const tradeId = args.trade_id as string;
      const ok = rejectTrade(tradeId, callerName);
      return ok ? `已拒绝交易 ${tradeId}` : `交易 ${tradeId} 不存在或不是你的交易`;
    }

    case 'get_pending_trades': {
      const pending = getPendingTradesFor(callerName);
      if (pending.length === 0) return '无待处理交易';
      return pending.map(t => {
        const offerStr = t.offerItems.map(i => `${i.name}x${i.count}`).join(', ');
        const wantStr = t.wantItems.map(i => `${i.name}x${i.count}`).join(', ');
        const role = t.from === callerName ? '你发起' : `${t.from}发起`;
        return `[${t.id}] ${role}: 给出${offerStr} 换取${wantStr} (${t.status})`;
      }).join('\n');
    }

    case 'form_team': {
      const teamName = args.team_name as string;
      const members = args.members as string[];
      const allMembers = [callerName, ...members.filter(m => m !== callerName)];
      const team = formTeam(teamName, allMembers, callerName);
      agentEventBus.publish({
        type: 'agent:team',
        action: 'form',
        teamName,
        agentName: callerName,
        members: allMembers,
        ts: Date.now(),
      });
      return `团队 "${teamName}" 已创建，成员: ${[...team.members].join(', ')}`;
    }

    case 'leave_team': {
      const teamName = args.team_name as string;
      const ok = leaveTeam(teamName, callerName);
      if (ok) {
        agentEventBus.publish({
          type: 'agent:team',
          action: 'leave',
          teamName,
          agentName: callerName,
          ts: Date.now(),
        });
      }
      return ok ? `已离开团队 "${teamName}"` : `未找到团队 "${teamName}"`;
    }

    case 'set_waypoint': {
      const name = args.name as string;
      const pos = { x: args.x as number, y: args.y as number, z: args.z as number };
      setWaypoint(name, pos, callerName);
      agentEventBus.publish({
        type: 'agent:waypoint',
        agentName: callerName,
        waypointName: name,
        position: pos,
        ts: Date.now(),
      });
      return `路标 "${name}" 已设置: (${pos.x}, ${pos.y}, ${pos.z})`;
    }

    case 'get_waypoints': {
      const wps = getAllWaypoints();
      if (wps.length === 0) return '无共享路标';
      return wps.map(w =>
        `${w.name}: (${w.position.x}, ${w.position.y}, ${w.position.z}) by ${w.createdBy}`,
      ).join('\n');
    }

    case 'share_skill': {
      const skillName = args.skill_name as string;
      const target = args.target as string;
      if (!agentRegistry.get(target)) return `未找到 Agent: ${target}`;

      // 从调用者的私有库复制到目标的私有库
      const meta = await skillLibrary.getMeta(callerName, skillName);
      if (!meta) return `你没有名为 "${skillName}" 的技能`;
      const code = await skillLibrary.getCode(callerName, skillName);
      if (!code) return `技能 "${skillName}" 的代码不存在`;

      // 检查目标是否已有
      const existing = await skillLibrary.getMeta(target, skillName);
      if (existing) return `${target} 已有名为 "${skillName}" 的技能`;

      const sharedMeta = { ...meta, author: `${meta.author}→${target}`, shared: false };
      await skillLibrary.saveSkill(target, skillName, code, sharedMeta);
      return `已将技能 "${skillName}" 分享给 ${target}`;
    }

    case 'get_social_summary': {
      // 这个工具需要 SocialMemory 实例，由调用者注入
      // 此处返回提示信息，实际实现在 game-master 中
      return '(社交摘要由 Game Master 注入)';
    }

    default:
      return `未知社交工具: ${tool}`;
  }
}
