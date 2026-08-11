import emailUtils from '../utils/email-utils';
import { settingConst } from '../const/entity-const';

const MIN_CODE_LENGTH = 4;
const MAX_CODE_LENGTH = 12;
const MAX_BODY_LENGTH = 6000;

const CODE_LABEL_SOURCE = [
	'verification\\s+code',
	'security\\s+code',
	'one[-\\s]?time\\s+(?:password|code)',
	'otp(?:\\s+code)?',
	'passcode',
	'login\\s+code',
	'sign[-\\s]?in\\s+code',
	'confirmation\\s+code',
	'authentication\\s+code',
	'auth\\s+code',
	'验证码',
	'验证代码',
	'一次性验证码',
	'一次性代码',
	'校验码',
	'动态码',
	'安全码',
	'安全代码',
	'登录码',
	'登录代码',
	'登入码',
	'确认码',
	'确认代码',
	'认证码',
	'认证代码',
	'認証コード',
	'確認コード',
	'セキュリティコード',
	'ワンタイム(?:パスワード|コード)'
].join('|');

const CODE_CANDIDATE_SOURCE = '(\\d{2,6}(?:\\s+\\d{2,6}){1,3}|[A-Za-z0-9]{2,6}(?:-[A-Za-z0-9]{2,6}){1,3}|[A-Za-z0-9]{4,12})';

const LOCAL_CODE_PATTERNS = [
	new RegExp(`(?:${CODE_LABEL_SOURCE})\\s*(?:is\\s*|为\\s*|是\\s*|[:：=\\-]\\s*)?${CODE_CANDIDATE_SOURCE}`, 'i'),
	new RegExp(`(?:your\\s+code)\\s*(?:is\\s*|[:：=\\-]\\s*)?${CODE_CANDIDATE_SOURCE}`, 'i'),
	new RegExp(`${CODE_CANDIDATE_SOURCE}\\s*(?:is\\s+)?(?:your\\s+)?(?:${CODE_LABEL_SOURCE})`, 'i'),
	new RegExp(`(?:use|enter|input|输入|填写|使用|请输入|请使用)\\s*${CODE_CANDIDATE_SOURCE}\\s*(?:to\\s+)?(?:verify|confirm|验证|校验|确认|認証|確認)`, 'i'),
	new RegExp(`(?:enter|input|输入|请输入)\\s+(?:the\\s+)?(?:code|验证码|校验码|认证码|確認コード|認証コード)\\s*(?:[:：=\\-]\\s*)?${CODE_CANDIDATE_SOURCE}`, 'i')
];

const VERIFICATION_HINT_RE = /(?:verification|verify|one[-\s]?time|otp|passcode|two[-\s]?factor|2fa|security\s+code|login\s+code|sign[-\s]?in|confirmation\s+code|authentication\s+code|验证码|验证代码|一次性验证码|一次性代码|校验码|动态码|安全码|安全代码|登录码|登录代码|登入码|确认码|确认代码|认证码|认证代码|一次性密码|二次验证|二步验证|認証|確認コード|ワンタイム|セキュリティコード)/i;
const CODE_CONTEXT_RE = /(?:your\s+(?:verification\s+|security\s+|login\s+|sign[-\s]?in\s+|confirmation\s+|authentication\s+)?code|temporary\s+(?:access\s+)?code)/i;

export function normalizeCode(rawCode) {
	if (typeof rawCode !== 'string') {
		return '';
	}

	const code = rawCode.trim().replace(/[\s-]+/g, '');

	if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) {
		return '';
	}

	if (!/^[A-Za-z0-9]+$/.test(code)) {
		return '';
	}

	// 纯字母验证码只接受全大写，避免把 “valid/verify/login” 之类普通单词误识别为验证码。
	if (!/\d/.test(code) && code !== code.toUpperCase()) {
		return '';
	}

	return code;
}

export function extractCodeLocally(subject = '', body = '') {
	const content = `${subject}\n${body}`;

	for (const pattern of LOCAL_CODE_PATTERNS) {
		const match = content.match(pattern);
		if (!match) {
			continue;
		}

		const code = normalizeCode(match[1]);
		if (code) {
			return code;
		}
	}

	return '';
}

export function isLikelyVerificationEmail(subject = '', body = '') {
	const content = `${subject}\n${body}`;
	return VERIFICATION_HINT_RE.test(content) || CODE_CONTEXT_RE.test(content);
}

function parseAiCode(result) {
	const content = typeof result === 'string' ? result : result?.response || '';
	if (!content) {
		return '';
	}

	try {
		const jsonText = content.match(/\{[\s\S]*\}/)?.[0] || content;
		const json = JSON.parse(jsonText);
		return normalizeCode(json.code);
	} catch (e) {
		console.error('AI 验证码结果解析失败: ', e);
		return '';
	}
}

const aiService = {
	async extractCode(c, email, options = {}) {
		if (!this.shouldExtractCode(options.aiCode, options.aiCodeFilter, email)) {
			return '';
		}

		try {
			const subject = email.subject || '';
			const text = emailUtils.formatText(email.text || '');
			const htmlText = emailUtils.htmlToText(email.html || '');
			const body = (htmlText || text).slice(0, MAX_BODY_LENGTH);

			if (!subject && !body) {
				return '';
			}

			// 优先使用确定性规则提取。常见验证码邮件完全不消耗 Workers AI 配额。
			const localCode = extractCodeLocally(subject, body);
			if (localCode) {
				return localCode;
			}

			// 普通邮件直接跳过 AI；只有疑似验证码邮件且本地规则未命中时才调用 AI 兜底。
			if (!isLikelyVerificationEmail(subject, body)) {
				return '';
			}

			const ai = c.env.ai;
			if (!ai?.run) {
				console.error('验证码提取失败: Workers AI binding 不可用');
				return '';
			}

			const result = await ai.run(c.env.ai_model || '@cf/meta/llama-3.1-8b-instruct', {
				messages: [
					{
						role: 'system',
						content: 'You extract one-time verification codes from emails. Return only JSON like {"code":"123456"} or {"code":""}. A valid code is 4 to 12 alphanumeric characters. If the email displays the code with spaces or hyphens, remove those separators in the returned code. Do not return URLs, dates, order numbers, phone numbers, recovery links, or explanatory text. If there is no verification code, return {"code":""}.'
					},
					{
						role: 'user',
						content: `Subject: ${subject}\n\n${body}`
					}
				],
				temperature: 0,
				max_tokens: 48
			});

			return parseAiCode(result);
		} catch (e) {
			console.error('验证码提取失败: ', e);
			return '';
		}
	},

	shouldExtractCode(aiCode, aiCodeFilterStr, email) {
		if (aiCode !== settingConst.aiCode.OPEN) {
			return false;
		}

		const filterList = aiCodeFilterStr ? aiCodeFilterStr.split(',').map(item => item.trim().toLowerCase()).filter(Boolean) : [];

		if (filterList.length === 0) {
			return true;
		}

		const fromEmail = (email.from?.address || '').trim().toLowerCase();
		const fromDomain = emailUtils.getDomain(fromEmail).toLowerCase();

		return filterList.some(item => item === fromEmail || item === fromDomain);
	}
};

export default aiService;
