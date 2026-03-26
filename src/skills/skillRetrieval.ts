/**
 * Skill Retrieval - 基于 TF-IDF 的技能检索
 *
 * 将任务描述与技能库中的技能描述进行相似度匹配，
 * 返回最相关的技能列表。
 *
 * 采用简单 TF-IDF + 余弦相似度，无需外部向量数据库。
 * 适用于 <1000 技能的规模。可后续升级为 Chroma/Qdrant。
 */

import type { SkillMeta } from './skillLibrary.js';

/** 分词：将文本拆分为小写 token */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/** 计算词频 (TF) */
function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  // 归一化
  const max = Math.max(...tf.values(), 1);
  for (const [k, v] of tf) {
    tf.set(k, v / max);
  }
  return tf;
}

/** 计算逆文档频率 (IDF) */
function inverseDocFrequency(corpus: string[][]): Map<string, number> {
  const n = corpus.length;
  const df = new Map<string, number>();
  for (const doc of corpus) {
    const seen = new Set(doc);
    for (const token of seen) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log(n / (1 + count)) + 1);
  }
  return idf;
}

/** TF-IDF 向量 */
function tfidfVector(tf: Map<string, number>, idf: Map<string, number>): Map<string, number> {
  const vec = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = idf.get(term) ?? 1;
    vec.set(term, tfVal * idfVal);
  }
  return vec;
}

/** 余弦相似度 */
function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [term, val] of a) {
    normA += val * val;
    const bVal = b.get(term);
    if (bVal !== undefined) dot += val * bVal;
  }
  for (const val of b.values()) {
    normB += val * val;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SkillMatch {
  skill: SkillMeta;
  similarity: number;
}

/**
 * 在技能列表中检索与任务描述最相关的技能
 * @param taskDescription - 任务描述文本
 * @param skills - 候选技能列表
 * @param topK - 返回前 K 个结果
 * @returns 按相似度降序排列的技能匹配列表
 */
export function findRelevantSkills(
  taskDescription: string,
  skills: SkillMeta[],
  topK = 5,
): SkillMatch[] {
  if (skills.length === 0) return [];

  // 构建语料库：每个技能的描述 + 标签
  const corpus = skills.map(s =>
    tokenize(`${s.description} ${s.tags.join(' ')}`),
  );
  const queryTokens = tokenize(taskDescription);

  // 计算 IDF
  const allDocs = [...corpus, queryTokens];
  const idf = inverseDocFrequency(allDocs);

  // 计算查询向量
  const queryTf = termFrequency(queryTokens);
  const queryVec = tfidfVector(queryTf, idf);

  // 计算每个技能的相似度
  const matches: SkillMatch[] = skills.map((skill, i) => {
    const docTf = termFrequency(corpus[i]);
    const docVec = tfidfVector(docTf, idf);
    return {
      skill,
      similarity: cosineSimilarity(queryVec, docVec),
    };
  });

  // 按相似度降序，取前 K
  return matches
    .filter(m => m.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);
}
