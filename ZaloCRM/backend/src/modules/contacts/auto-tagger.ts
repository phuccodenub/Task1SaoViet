/**
 * auto-tagger.ts — Applies auto-tags to contacts based on lead score and activity.
 * Preserves user-defined tags; removes and replaces auto-tags on each run.
 */
import { prisma } from '../../shared/database/prisma-client.js';

const AUTO_TAGS = [
  'hot-lead',
  'warm-lead',
  'cold-lead',
  'inactive-14d',
  'inactive-30d',
  'has-appointment',
] as const;

export async function applyAutoTags(
  contactId: string,
  score: number,
  lastActivity: Date | null,
): Promise<string[]> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { tags: true },
  });

  const raw = contact?.tags;
  const existingTags: string[] = Array.isArray(raw) ? (raw as string[]) : [];

  // Remove all existing auto-tags; keep user-defined tags
  const userTags = existingTags.filter((t) => !(AUTO_TAGS as readonly string[]).includes(t));

  const newAutoTags: string[] = [];

  // Score-based tags
  if (score >= 70) newAutoTags.push('hot-lead');
  else if (score >= 40) newAutoTags.push('warm-lead');
  else newAutoTags.push('cold-lead');

  // Inactivity tags
  if (lastActivity) {
    const daysSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) newAutoTags.push('inactive-30d');
    else if (daysSince > 14) newAutoTags.push('inactive-14d');
  }

  // Future appointment tag
  const futureApt = await prisma.appointment.findFirst({
    where: {
      contactId,
      status: 'scheduled',
      appointmentDate: { gte: new Date() },
    },
    select: { id: true },
  });
  if (futureApt) newAutoTags.push('has-appointment');

  // Merge: unique values, user tags first
  const finalTags = [...new Set([...userTags, ...newAutoTags])];

  return finalTags;
}
