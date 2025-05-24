import 'dotenv/config';
import Color from './lib/color.js';

import pkg from '@whiskeysockets/baileys';
const { makeWASocket, delay, useMultiFileAuthState, fetchLatestBaileysVersion, jidNormalizedUser, DisconnectReason, Browsers, makeCacheableSignalKeyStore, makeInMemoryStore } = pkg;
import pino from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import os from 'os';
import { exec } from 'child_process';

import treeKill from './lib/tree-kill.js';
import serialize, { Client } from './lib/serialize.js';
import { formatSize, parseFileSize, sendTelegram } from './lib/function.js';

const logger = pino({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({ class: 'hisoka' });
logger.level = 'fatal';

const usePairingCode = process.env.PAIRING_NUMBER;

const pathContacts = './database/contacts.json';
const pathMetadata = './database/groups.json';

const store = {
	contacts: {},
	groupMetadata: {},
	loadMessage: async () => '',
	writeToFile: () => {}
}

// Load contacts and groups if exists
if (fs.existsSync(pathContacts)) {
	store.contacts = JSON.parse(fs.readFileSync(pathContacts, 'utf-8'));
}
if (fs.existsSync(pathMetadata)) {
	store.groupMetadata = JSON.parse(fs.readFileSync(pathMetadata, 'utf-8')); 
}

const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState(`./${process.env.SESSION_NAME}`);
	const { version, isLatest } = await fetchLatestBaileysVersion();

	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

	/**
	 * @type {import('@whiskeysockets/baileys').WASocket}
	 */
	const hisoka = makeWASocket({
		version,
		logger,
		printQRInTerminal: false,
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		browser: Browsers.ubuntu('Chrome'),
		markOnlineOnConnect: false,
		generateHighQualityLinkPreview: true,
		syncFullHistory: true,
		retryRequestDelayMs: 10,
		transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 10 },
		defaultQueryTimeoutMs: undefined,
		maxMsgRetryCount: 15,
		appStateMacVerification: {
			patch: true,
			snapshot: true,
		},
		getMessage: async key => {
			const jid = jidNormalizedUser(key.remoteJid);
			const msg = await store.loadMessage(jid, key.id);

			return msg?.message || '';
		},
		shouldSyncHistoryMessage: msg => {
			console.log(`\x1b[32mMemuat Chat [${msg.progress}%]\x1b[39m`);
			return !!msg.syncType;
		},
	});

	await Client({ hisoka, store });

	// login dengan pairing
	if (usePairingCode && !hisoka.authState.creds.registered) {
		try {
			let phoneNumber = usePairingCode.replace(/[^0-9]/g, '');

			await delay(3000);
			let code = await hisoka.requestPairingCode(phoneNumber);
			console.log(`\x1b[32m${code?.match(/.{1,4}/g)?.join('-') || code}\x1b[39m`);
		} catch {
			console.error('Gagal mendapatkan kode pairing');
			process.exit(1);
		}
	}

	// ngewei info, restart or close
	hisoka.ev.on('connection.update', async update => {
		const { lastDisconnect, connection, qr } = update;
		if (qr) {
			console.info('QR Code: ', qr);
		}
		if (connection) {
			console.info(`Connection Status : ${connection}`);
		}

		if (connection === 'close') {
			let reason = new Boom(lastDisconnect?.error)?.output.statusCode;

			switch (reason) {
				case DisconnectReason.multideviceMismatch:
				case DisconnectReason.loggedOut:
				case 403:
					console.error(lastDisconnect.error?.message);
					await hisoka.logout();
					fs.rmSync(`./${process.env.SESSION_NAME}`, { recursive: true, force: true });
					exec('npm run stop:pm2', err => {
						if (err) return treeKill(process.pid);
					});
					break;
				default:
					console.error(lastDisconnect.error?.message);
					await startSock();
			}
		}

		if (connection === 'open') {
			hisoka.sendMessage(jidNormalizedUser(hisoka.user.id), { text: `${hisoka.user?.name} has Connected...` });
		}
	});

	// write session kang
	hisoka.ev.on('creds.update', saveCreds);

	// contacts
	if (fs.existsSync(pathContacts)) {
		store.contacts = JSON.parse(fs.readFileSync(pathContacts, 'utf-8'));
	} else {
		fs.writeFileSync(pathContacts, JSON.stringify({}));
	}
	// group metadata
	if (fs.existsSync(pathMetadata)) {
		store.groupMetadata = JSON.parse(fs.readFileSync(pathMetadata, 'utf-8'));
	} else {
		fs.writeFileSync(pathMetadata, JSON.stringify({}));
	}

	// add contacts update to store
	hisoka.ev.on('contacts.update', update => {
		for (let contact of update) {
			let id = jidNormalizedUser(contact.id);
			if (store && store.contacts) store.contacts[id] = { ...(store.contacts?.[id] || {}), ...(contact || {}) };
		}
	});

	// add contacts upsert to store
	hisoka.ev.on('contacts.upsert', update => {
		for (let contact of update) {
			let id = jidNormalizedUser(contact.id);
			if (store && store.contacts) store.contacts[id] = { ...(contact || {}), isContact: true };
		}
	});

	// nambah perubahan grup ke store
	hisoka.ev.on('groups.update', updates => {
		for (const update of updates) {
			const id = update.id;
			if (store.groupMetadata[id]) {
				store.groupMetadata[id] = { ...(store.groupMetadata[id] || {}), ...(update || {}) };
			}
		}
	});

	// merubah status member
	hisoka.ev.on('group-participants.update', ({ id, participants, action }) => {
		const metadata = store.groupMetadata[id];
		if (metadata) {
			switch (action) {
				case 'add':
				case 'revoked_membership_requests':
					metadata.participants.push(...participants.map(id => ({ id: jidNormalizedUser(id), admin: null })));
					break;
				case 'demote':
				case 'promote':
					for (const participant of metadata.participants) {
						let id = jidNormalizedUser(participant.id);
						if (participants.includes(id)) {
							participant.admin = action === 'promote' ? 'admin' : null;
						}
					}
					break;
				case 'remove':
					metadata.participants = metadata.participants.filter(p => !participants.includes(jidNormalizedUser(p.id)));
					break;
			}
		}
	});

	// bagian pepmbaca status ono ng kene
	hisoka.ev.on('messages.upsert', async ({ messages }) => {
		if (!messages[0].message) return;
		let m = await serialize(hisoka, messages[0], store);

		// nambah semua metadata ke store
		if (store.groupMetadata && Object.keys(store.groupMetadata).length === 0) store.groupMetadata = await hisoka.groupFetchAllParticipating();

		// untuk membaca pesan status
		if (m.key && !m.key.fromMe && m.key.remoteJid === 'status@broadcast') {
			if (m.type === 'protocolMessage' && m.message.protocolMessage.type === 0) return;
			await hisoka.readMessages([m.key]);
			let id = m.key.participant;
			let name = hisoka.getName(id);

			// react status
			const emojis = process.env.REACT_STATUS.split(',')
				.map(e => e.trim())
				.filter(Boolean);

			if (emojis.length) {
				await hisoka.sendMessage(
					'status@broadcast',
					{
						react: { key: m.key, text: emojis[Math.floor(Math.random() * emojis.length)] },
					},
					{
						statusJidList: [jidNormalizedUser(hisoka.user.id), jidNormalizedUser(id)],
					}
				);
			}

			if (process.env.TELEGRAM_TOKEN && process.env.ID_TELEGRAM) {
				if (m.isMedia) {
					let media = await hisoka.downloadMediaMessage(m);
					let caption = `Dari : https://wa.me/${id.split('@')[0]} (${name})${m.body ? `\n\n${m.body}` : ''}`;
					await sendTelegram(process.env.ID_TELEGRAM, media, { type: /audio/.test(m.msg.mimetype) ? 'document' : '', caption });
				} else await sendTelegram(process.env.ID_TELEGRAM, `Dari : https://wa.me/${id.split('@')[0]} (${name})\n\n${m.body}`);
			}
		}

		// status self apa publik
		if (process.env.SELF === 'true' && !m.isOwner) return;

		// memunculkan ke log
		if (m.message && !m.isBot) {
			// Notifikasi status terpisah
			if (m.key && !m.key.fromMe && m.key.remoteJid === 'status@broadcast') {
				console.log('\n╭━━━━『 Status Update 』━━━━╮');
				console.log(`│ • Creator: ${Color.magenta(hisoka.getName(m.sender))}`);
				console.log(`│ • Type: ${Color.blue(m.type)}`);
				if (m.body) console.log(`│ • Caption: ${Color.green(m.body)}`);
				console.log('╰━━━━━━━━━━━━━━━━━━━━━╯\n');
				return;
			}
		}

		// kanggo kes
		await (await import(`./message.js?v=${Date.now()}`)).default(hisoka, store, m);
	});

	setInterval(async () => {
		// untuk auto restart ketika RAM sisa 300MB
		const memoryUsage = os.totalmem() - os.freemem();

		if (memoryUsage > os.totalmem() - parseFileSize(process.env.AUTO_RESTART, false)) {
			await hisoka.sendMessage(
				jidNormalizedUser(hisoka.user.id),
				{ text: `penggunaan RAM mencapai *${formatSize(memoryUsage)}* waktunya merestart...` },
				{ ephemeralExpiration: 24 * 60 * 60 * 1000 }
			);
			exec('npm run restart:pm2', err => {
				if (err) return process.send('reset');
			});
		}
	}, 10 * 1000); // tiap 10 detik

	process.on('uncaughtException', console.error);
	process.on('unhandledRejection', console.error);
};

startSock();