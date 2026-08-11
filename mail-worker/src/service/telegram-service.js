import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';
import domainUtils from "../utils/domain-uitls";

const telegramService = {

	async getEmailContent(c, params) {

		const { token } = params

		const result = await jwtUtils.verifyToken(c, token);

		if (!result) {
			return emailTextTemplate('Access denied')
		}

		const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();

		if (emailRow) {

			if (emailRow.content) {
				const { r2Domain } = await settingService.query(c);
				return emailHtmlTemplate(emailRow.content || '', r2Domain)
			} else {
				return emailTextTemplate(emailRow.text || '')
			}

		} else {
			return emailTextTemplate('The email does not exist')
		}

	},

	async testBot(c, options = {}) {
		const { tgBotToken: savedTgBotToken, tgChatId: savedTgChatId } = await settingService.query(c);
		// 与正式推送保持一致：Worker Secret 优先，其次使用当前弹窗新输入的 Token，最后使用已保存 Token。
		const tgBotToken = c.env.TG_BOT_TOKEN || options.tgBotToken || savedTgBotToken;
		const tgChatId = options.tgChatId || savedTgChatId;

		if (!tgBotToken) {
			throw new Error('Telegram Bot Token 未配置');
		}

		const tgChatIds = (tgChatId || '').split(',').map(item => item.trim()).filter(Boolean);
		if (tgChatIds.length === 0) {
			throw new Error('Telegram Chat ID 未配置');
		}

		const text = '✅ <b>Cloud Mail Telegram 测试成功</b>\n\nBot Token 与 Chat ID 配置正常，可以接收验证码推送。';
		const results = await Promise.all(tgChatIds.map(async chatId => {
			try {
				const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						parse_mode: 'HTML',
						text
					})
				});

				let data = null;
				try {
					data = await res.json();
				} catch (_) {
					// Telegram 异常响应可能不是 JSON，下面使用 HTTP 状态兜底。
				}

				if (!res.ok || data?.ok === false) {
					return {
						chatId,
						ok: false,
						error: data?.description || `HTTP ${res.status}`
					};
				}

				return { chatId, ok: true };
			} catch (e) {
				return { chatId, ok: false, error: e.message };
			}
		}));

		const failures = results.filter(item => !item.ok);
		if (failures.length > 0) {
			const message = failures.map(item => `${item.chatId}: ${item.error}`).join('; ');
			throw new Error(`Telegram 测试失败: ${message}`);
		}

		return {
			total: results.length,
			successCount: results.length
		};
	},

	async sendEmailToBot(c, email) {

		const { tgBotToken: savedTgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);
		const tgBotToken = c.env.TG_BOT_TOKEN || savedTgBotToken;

		if (!tgBotToken) {
			console.error('转发 Telegram 失败: TG_BOT_TOKEN 未配置');
			return;
		}

		const tgChatIds = tgChatId.split(',');

		const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId })

		const webAppUrl = customDomain ? `${domainUtils.toOssDomain(customDomain)}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404'
		const inlineKeyboard = [
			[
				{
					text: 'View',
					web_app: { url: webAppUrl }
				}
			]
		];

		if (email.code) {
			inlineKeyboard.push([
				{
					text: email.code,
					copy_text: { text: email.code }
				}
			]);
		}

		await Promise.all(tgChatIds.map(async chatId => {
			try {
				const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json'
					},
					body: JSON.stringify({
						chat_id: chatId,
						parse_mode: 'HTML',
						text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
						reply_markup: {
							inline_keyboard: inlineKeyboard
						}
					})
				});
				if (!res.ok) {
					console.error(`转发 Telegram 失败 status: ${res.status} response: ${await res.text()}`);
				}
			} catch (e) {
				console.error(`转发 Telegram 失败:`, e.message);
			}
		}));

	}

}

export default telegramService
