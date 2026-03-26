/**
 * Skill Library - Voyager 风格可执行技能库
 *
 * 管理可执行 JS 技能的存储、检索和生命周期。
 * 技能存储为：skills-db/<owner>/code/<name>.js + skills-db/<owner>/meta/<name>.json
 *
 * 两级库：
 * - shared: 所有 Agent 可用的高质量技能
 * - private/<agentName>: 每个 Agent 的私有技能
 */

import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

export interface SkillMeta {
  name: string;
  description: string;
  tags: string[];
  successCount: number;
  failCount: number;
  author: string;
  shared: boolean;
  deprecated: boolean;
  createdAt: number;
  lastUsed: number;
}

const SKILLS_ROOT = join(process.cwd(), 'skills-db');

function getSkillDir(owner: string): string {
  return join(SKILLS_ROOT, owner);
}

function codeDir(owner: string): string {
  return join(getSkillDir(owner), 'code');
}

function metaDir(owner: string): string {
  return join(getSkillDir(owner), 'meta');
}

async function ensureDirs(owner: string): Promise<void> {
  await mkdir(codeDir(owner), { recursive: true });
  await mkdir(metaDir(owner), { recursive: true });
}

export class SkillLibrary {
  /** 缓存：owner → skillName → SkillMeta */
  private cache = new Map<string, Map<string, SkillMeta>>();

  /** 加载某个 owner 的所有技能元数据 */
  async loadMeta(owner: string): Promise<Map<string, SkillMeta>> {
    if (this.cache.has(owner)) return this.cache.get(owner)!;

    const dir = metaDir(owner);
    const map = new Map<string, SkillMeta>();
    if (!existsSync(dir)) {
      this.cache.set(owner, map);
      return map;
    }

    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await readFile(join(dir, file), 'utf-8');
          const meta = JSON.parse(raw) as SkillMeta;
          map.set(meta.name, meta);
        } catch { /* skip corrupt files */ }
      }
    } catch { /* dir unreadable */ }

    this.cache.set(owner, map);
    return map;
  }

  /** 获取单个技能元数据 */
  async getMeta(owner: string, name: string): Promise<SkillMeta | undefined> {
    const metas = await this.loadMeta(owner);
    return metas.get(name);
  }

  /** 获取技能代码 */
  async getCode(owner: string, name: string): Promise<string | null> {
    const path = join(codeDir(owner), `${name}.js`);
    if (!existsSync(path)) return null;
    return readFile(path, 'utf-8');
  }

  /** 保存技能（代码 + 元数据） */
  async saveSkill(owner: string, name: string, code: string, meta: SkillMeta): Promise<void> {
    await ensureDirs(owner);
    await writeFile(join(codeDir(owner), `${name}.js`), code, 'utf-8');
    await writeFile(join(metaDir(owner), `${name}.json`), JSON.stringify(meta, null, 2), 'utf-8');

    // 更新缓存
    if (!this.cache.has(owner)) this.cache.set(owner, new Map());
    this.cache.get(owner)!.set(name, meta);
  }

  /** 删除技能 */
  async deleteSkill(owner: string, name: string): Promise<boolean> {
    const codePath = join(codeDir(owner), `${name}.js`);
    const metaPath = join(metaDir(owner), `${name}.json`);
    try {
      if (existsSync(codePath)) await rm(codePath);
      if (existsSync(metaPath)) await rm(metaPath);
      this.cache.get(owner)?.delete(name);
      return true;
    } catch {
      return false;
    }
  }

  /** 记录成功执行 */
  async recordSuccess(owner: string, name: string): Promise<void> {
    const meta = await this.getMeta(owner, name);
    if (!meta) return;
    meta.successCount++;
    meta.lastUsed = Date.now();
    await this.saveMeta(owner, meta);
  }

  /** 记录失败执行 */
  async recordFailure(owner: string, name: string): Promise<void> {
    const meta = await this.getMeta(owner, name);
    if (!meta) return;
    meta.failCount++;
    meta.lastUsed = Date.now();
    // 成功率过低则标记废弃
    const total = meta.successCount + meta.failCount;
    if (total >= 10 && this.getSuccessRate(meta) < 0.2) {
      meta.deprecated = true;
    }
    await this.saveMeta(owner, meta);
  }

  /** 提升技能到共享库 */
  async promoteToShared(owner: string, name: string): Promise<boolean> {
    const meta = await this.getMeta(owner, name);
    if (!meta) return false;

    const total = meta.successCount + meta.failCount;
    if (total < 3 || this.getSuccessRate(meta) < 0.7) return false;

    const code = await this.getCode(owner, name);
    if (!code) return false;

    // 检查共享库是否已有同名技能
    const existing = await this.getMeta('shared', name);
    if (existing) return false;

    const sharedMeta: SkillMeta = { ...meta, shared: true };
    await this.saveSkill('shared', name, code, sharedMeta);
    meta.shared = true;
    await this.saveMeta(owner, meta);
    return true;
  }

  /** 列出所有可用技能（共享 + 私有） */
  async listAvailable(owner: string): Promise<SkillMeta[]> {
    const shared = await this.loadMeta('shared');
    const priv = await this.loadMeta(owner);
    const all = new Map<string, SkillMeta>();

    for (const [name, meta] of shared) {
      if (!meta.deprecated) all.set(name, meta);
    }
    for (const [name, meta] of priv) {
      if (!meta.deprecated && !all.has(name)) all.set(name, meta);
    }

    return [...all.values()];
  }

  /** 获取成功率 */
  getSuccessRate(meta: SkillMeta): number {
    const total = meta.successCount + meta.failCount;
    return total === 0 ? 0 : meta.successCount / total;
  }

  private async saveMeta(owner: string, meta: SkillMeta): Promise<void> {
    await ensureDirs(owner);
    await writeFile(join(metaDir(owner), `${meta.name}.json`), JSON.stringify(meta, null, 2), 'utf-8');
    if (!this.cache.has(owner)) this.cache.set(owner, new Map());
    this.cache.get(owner)!.set(meta.name, meta);
  }
}

/** 全局单例 */
export const skillLibrary = new SkillLibrary();
