/**
 * FigmaForge Animation Mapping
 * 
 * Maps Figma prototype reactions/transitions to Roblox TweenService code.
 * 
 * Luau-only — RBXMX doesn't support embedded scripts.
 * 
 * Strategy:
 *   - ON_CLICK/ON_HOVER/ON_PRESS → InputBegan/InputEnded connections
 *   - DISSOLVE → Tween BackgroundTransparency + child transparency
 *   - SMART_ANIMATE → Tween Position/Size/Rotation/Transparency
 *   - MOVE_IN/SLIDE_IN → Tween from offscreen to final position
 *   - Easing types → Enum.EasingStyle/EasingDirection mapping
 */

import type {
  FigmaForgeNode, FigmaReaction, FigmaTransition,
  FigmaEasingType, FigmaTriggerType,
} from './figma-forge-ir';
import { luaEscape } from './figma-forge-shared';

// ─── Easing Mapping ──────────────────────────────────────────────

interface RobloxEasing {
  style: string;
  direction: string;
}

const EASING_MAP: Record<FigmaEasingType, RobloxEasing> = {
  LINEAR:               { style: 'Enum.EasingStyle.Linear',  direction: 'Enum.EasingDirection.InOut' },
  EASE_IN:              { style: 'Enum.EasingStyle.Quad',    direction: 'Enum.EasingDirection.In' },
  EASE_OUT:             { style: 'Enum.EasingStyle.Quad',    direction: 'Enum.EasingDirection.Out' },
  EASE_IN_AND_OUT:      { style: 'Enum.EasingStyle.Quad',    direction: 'Enum.EasingDirection.InOut' },
  EASE_IN_BACK:         { style: 'Enum.EasingStyle.Back',    direction: 'Enum.EasingDirection.In' },
  EASE_OUT_BACK:        { style: 'Enum.EasingStyle.Back',    direction: 'Enum.EasingDirection.Out' },
  EASE_IN_AND_OUT_BACK: { style: 'Enum.EasingStyle.Back',    direction: 'Enum.EasingDirection.InOut' },
  CUSTOM_BEZIER:        { style: 'Enum.EasingStyle.Quad',    direction: 'Enum.EasingDirection.InOut' }, // approximation
};

function mapEasing(easing: { type: FigmaEasingType }): RobloxEasing {
  return EASING_MAP[easing.type] ?? EASING_MAP.LINEAR;
}

// ─── Trigger Mapping ─────────────────────────────────────────────

interface TriggerBinding {
  eventType: 'click' | 'hover_enter' | 'hover_leave' | 'press' | 'timeout';
  delay?: number;
}

function mapTrigger(trigger: { type: FigmaTriggerType; delay?: number }): TriggerBinding {
  switch (trigger.type) {
    case 'ON_CLICK':     return { eventType: 'click' };
    case 'ON_HOVER':     return { eventType: 'hover_enter' };
    case 'MOUSE_ENTER':  return { eventType: 'hover_enter' };
    case 'MOUSE_LEAVE':  return { eventType: 'hover_leave' };
    case 'ON_PRESS':     return { eventType: 'press' };
    case 'MOUSE_DOWN':   return { eventType: 'press' };
    case 'MOUSE_UP':     return { eventType: 'click' };
    case 'AFTER_TIMEOUT': return { eventType: 'timeout', delay: trigger.delay ?? 0 };
    case 'ON_DRAG':      return { eventType: 'click' }; // approximate
    default:             return { eventType: 'click' };
  }
}

// ─── Animation Code Generation ──────────────────────────────────

export interface AnimationSnippet {
  /** The Luau code for this animation connection */
  code: string;
  /** Node ID this animation is attached to */
  nodeId: string;
  /** 1-based ref index from the Luau generator's refs[] table */
  refIdx: number;
  /** Node name for comments */
  nodeName: string;
  /** Warning if approximation was necessary */
  warning?: string;
}

// ─── Direction Helper (DRY for MOVE_IN/OUT and SLIDE_IN/OUT) ────

function offscreenUDim2(direction: string): string {
  switch (direction) {
    case 'LEFT':  return 'UDim2.new(-1, 0, 0, 0)';
    case 'RIGHT': return 'UDim2.new(1, 0, 0, 0)';
    case 'TOP':   return 'UDim2.new(0, 0, -1, 0)';
    case 'BOTTOM': return 'UDim2.new(0, 0, 1, 0)';
    default:      return 'UDim2.new(1, 0, 0, 0)'; // RIGHT default
  }
}

/**
 * Generate a Luau TweenService tween for a transition.
 * Returns the tween creation code referencing the target by variable name.
 */
function generateTweenCode(
  targetVar: string,
  transition: FigmaTransition,
  suffix: string = '',
): string {
  const easing = mapEasing(transition.easing);
  const duration = transition.duration.toFixed(2);

  const lines: string[] = [];
  lines.push(`local tweenInfo${suffix} = TweenInfo.new(${duration}, ${easing.style}, ${easing.direction})`);

  switch (transition.type) {
    case 'DISSOLVE':
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {`);
      lines.push(`  BackgroundTransparency = ${targetVar}.BackgroundTransparency == 0 and 1 or 0`);
      lines.push(`})`);
      break;

    case 'SMART_ANIMATE':
      // Generic property interpolation — position + size
      lines.push(`-- SMART_ANIMATE: captures current state and tweens to new state`);
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {`);
      lines.push(`  Position = ${targetVar}.Position,`);
      lines.push(`  Size = ${targetVar}.Size,`);
      lines.push(`  Rotation = ${targetVar}.Rotation`);
      lines.push(`})`);
      break;

    case 'MOVE_IN':
    case 'SLIDE_IN': {
      const offscreen = offscreenUDim2(transition.direction ?? 'RIGHT');
      lines.push(`local finalPos${suffix} = ${targetVar}.Position`);
      lines.push(`${targetVar}.Position = ${offscreen}`);
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {`);
      lines.push(`  Position = finalPos${suffix}`);
      lines.push(`})`);
      break;
    }

    case 'MOVE_OUT':
    case 'SLIDE_OUT': {
      const offscreen = offscreenUDim2(transition.direction ?? 'RIGHT');
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {`);
      lines.push(`  Position = ${offscreen}`);
      lines.push(`})`);
      break;
    }

    case 'PUSH':
      // Push = dissolve + move out combined, approximate with dissolve
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {`);
      lines.push(`  BackgroundTransparency = 1`);
      lines.push(`})`);
      break;

    default:
      lines.push(`-- Unsupported transition type: ${transition.type}`);
      lines.push(`local tween${suffix} = TweenService:Create(${targetVar}, tweenInfo${suffix}, {})`);
  }

  lines.push(`tween${suffix}:Play()`);
  return lines.join('\n');
}

/**
 * Generate event binding code for a trigger type.
 */
function generateTriggerBinding(
  targetVar: string,
  trigger: TriggerBinding,
  tweenCode: string,
  reverseTweenCode: string | null,
  index: number,
): string {
  const lines: string[] = [];

  switch (trigger.eventType) {
    case 'click':
      lines.push(`${targetVar}.InputBegan:Connect(function(input)`);
      lines.push(`  if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then`);
      lines.push(`    ${tweenCode.split('\n').join('\n    ')}`);
      lines.push(`  end`);
      lines.push(`end)`);
      break;

    case 'hover_enter':
      lines.push(`${targetVar}.MouseEnter:Connect(function()`);
      lines.push(`  ${tweenCode.split('\n').join('\n  ')}`);
      lines.push(`end)`);
      break;

    case 'hover_leave':
      lines.push(`${targetVar}.MouseLeave:Connect(function()`);
      lines.push(`  ${tweenCode.split('\n').join('\n  ')}`);
      lines.push(`end)`);
      break;

    case 'press':
      // Press: apply on InputBegan, reverse on InputEnded
      lines.push(`${targetVar}.InputBegan:Connect(function(input)`);
      lines.push(`  if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then`);
      lines.push(`    ${tweenCode.split('\n').join('\n    ')}`);
      lines.push(`  end`);
      lines.push(`end)`);
      if (reverseTweenCode) {
        lines.push(`${targetVar}.InputEnded:Connect(function(input)`);
        lines.push(`  if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then`);
        lines.push(`    ${reverseTweenCode.split('\n').join('\n    ')}`);
        lines.push(`  end`);
        lines.push(`end)`);
      }
      break;

    case 'timeout':
      const delay = (trigger.delay ?? 0).toFixed(2);
      lines.push(`task.delay(${delay}, function()`);
      lines.push(`  ${tweenCode.split('\n').join('\n  ')}`);
      lines.push(`end)`);
      break;
  }

  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Collect all animation snippets from a node tree.
 * @param root - Root IR node
 * @param nodeIdToRefIdx - Map of node.id → refs[N] index from the Luau generator
 */
export function collectAnimations(
  root: FigmaForgeNode,
  nodeIdToRefIdx: Map<string, number>,
): AnimationSnippet[] {
  const snippets: AnimationSnippet[] = [];
  walkNode(root, snippets, nodeIdToRefIdx);
  return snippets;
}

function walkNode(
  node: FigmaForgeNode,
  snippets: AnimationSnippet[],
  nodeIdToRefIdx: Map<string, number>,
): void {
  if (node.reactions && node.reactions.length > 0) {
    const refIdx = nodeIdToRefIdx.get(node.id);
    if (refIdx === undefined) {
      console.warn(`[FigmaForge] ⚠ Animation on "${node.name}" (${node.id}) skipped — node not in instruction table`);
    } else {
      for (let i = 0; i < node.reactions.length; i++) {
        const reaction = node.reactions[i];
        const snippet = mapReaction(node, reaction, i, refIdx);
        if (snippet) snippets.push(snippet);
      }
    }
  }

  if (node.children) {
    for (const child of node.children) {
      walkNode(child, snippets, nodeIdToRefIdx);
    }
  }
}

function mapReaction(
  node: FigmaForgeNode,
  reaction: FigmaReaction,
  index: number,
  refIdx: number,
): AnimationSnippet | null {
  const transition = reaction.action.transition;
  if (!transition) return null;

  const trigger = mapTrigger(reaction.trigger);
  const targetVar = `refs[${refIdx}]`;
  const suffix = index > 0 ? `_${index}` : '';
  
  const tweenCode = generateTweenCode(targetVar, transition, suffix);
  
  // For press triggers, generate a reverse tween for InputEnded
  let reverseTweenCode: string | null = null;
  if (trigger.eventType === 'press' && transition.type === 'DISSOLVE') {
    reverseTweenCode = generateTweenCode(targetVar, { ...transition, type: 'DISSOLVE' }, `${suffix}_rev`);
  }
  
  const fullCode = generateTriggerBinding(targetVar, trigger, tweenCode, reverseTweenCode, index);

  const escapedName = luaEscape(node.name);
  const snippet: AnimationSnippet = {
    code: `-- Animation for "${escapedName}" [refs[${refIdx}]] (${reaction.trigger.type} → ${transition.type})\n${fullCode}`,
    nodeId: node.id,
    refIdx,
    nodeName: node.name,
  };

  // Warn about approximations
  if (transition.easing.type === 'CUSTOM_BEZIER') {
    snippet.warning = `Custom bezier on "${escapedName}" approximated as Quad easing`;
  }
  if (transition.type === 'PUSH') {
    snippet.warning = `Push transition on "${escapedName}" approximated as dissolve`;
  }

  return snippet;
}

/**
 * Generate the full Luau animation block to append after UI creation.
 * Includes TweenService require and all collected animation connections.
 */
export function generateAnimationBlock(snippets: AnimationSnippet[]): string {
  if (snippets.length === 0) return '';

  const lines: string[] = [
    '',
    '-- ═══════════════════════════════════════════════════════════════',
    '-- ANIMATIONS (generated from Figma prototype interactions)',
    '-- ═══════════════════════════════════════════════════════════════',
    'local TweenService = game:GetService("TweenService")',
    '',
  ];

  for (const snippet of snippets) {
    if (snippet.warning) {
      lines.push(`-- ⚠ ${snippet.warning}`);
    }
    lines.push(snippet.code);
    lines.push('');
  }

  return lines.join('\n');
}
