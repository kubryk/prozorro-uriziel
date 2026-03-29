import { Logger } from '@nestjs/common';
import { Context } from 'telegraf';

const logger = new Logger('TelegramGuard');

let allowedUsers: Set<number> | null = null;

function getAllowedUsers(): Set<number> {
  if (allowedUsers) return allowedUsers;

  const raw = process.env.TELEGRAM_ALLOWED_USERS || '';
  allowedUsers = new Set(
    raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n)),
  );

  if (allowedUsers.size === 0) {
    logger.warn('TELEGRAM_ALLOWED_USERS is empty — bot will reject all users');
  }

  return allowedUsers;
}

export function authMiddleware() {
  return async (ctx: Context, next: () => Promise<void>) => {
    const userId = ctx.from?.id;
    if (!userId || !getAllowedUsers().has(userId)) {
      logger.warn(`Unauthorized Telegram access attempt from user ${userId}`);
      await ctx.reply('⛔ Доступ заборонено. Зверніться до адміністратора.');
      return;
    }
    await next();
  };
}
