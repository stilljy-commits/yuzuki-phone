// Keep bounded context while retaining portions from throughout long RP replies.
export function sampleContactText(value, limit) {
    const raw = String(value || '').trim();
    if (raw.length <= limit) return raw;
    const count = 4, separator = '\n[…节选…]\n';
    const chunk = Math.max(1, Math.floor((limit - separator.length * (count - 1)) / count));
    return Array.from({ length: count }, (_, i) => {
        const start = Math.round(i * (raw.length - chunk) / (count - 1));
        return raw.slice(start, start + chunk);
    }).join(separator);
}

export function getContactGenerationScope(context = {}) {
    const char = context.characters?.[context.characterId];
    return JSON.stringify([context.characterId ?? '', context.groupId ?? context.group_id ?? context.group?.id ?? '',
        context.chatMetadata?.file_name || context.chatId || '', char?.avatar || char?.data?.avatar || '', char?.name || char?.data?.name || context.name2 || '']);
}

export function buildContactHistory(context, { userName, charName, isLobby = false, databaseAvailable = false } = {}) {
    const messages = (Array.isArray(context.chat) ? context.chat : []).flatMap((msg, index) => {
        if (msg?.is_system) return [];
        const text = String(msg?.mes || msg?.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || (isLobby && !msg?.is_user && (/API 连接[\s\S]*角色管理[\s\S]*扩展程序|如果您已连接到一个\s*API|将角色设为欢迎页面的助手/.test(text)))) return [];
        const speaker = String(msg?.name || (msg?.is_user ? userName : charName) || '角色').trim().slice(0, 100);
        return [{ index, speaker, text, isUser: !!msg?.is_user }];
    });
    const recentLimit = databaseAvailable ? 10 : 30;
    const recent = messages.slice(-recentLimit), older = databaseAvailable ? [] : messages.slice(0, Math.max(0, messages.length - recentLimit));
    const selectedOlder = [];
    for (let i = 0; i < Math.min(12, older.length); i++) {
        const index = older.length <= 12 ? i : Math.round(i * (older.length - 1) / 11);
        selectedOlder.push(older[index]);
    }
    const lines = [...selectedOlder.map(item => ({ ...item, limit: 400 })), ...recent.map(item => ({ ...item, limit: databaseAvailable ? 650 : 900 }))]
        .map(item => `[第${item.index + 1}条] ${item.speaker}: ${sampleContactText(item.text, item.limit)}`);
    const candidates = [...new Set([charName, ...messages.filter(item => !item.isUser).map(item => item.speaker)])]
        .filter(name => name && name !== userName && !/^(assistant|system|旁白|系统|角色)$/i.test(name)).slice(0, 80);
    return { text: lines.join('\n'), candidates, total: messages.length, recent: recent.length, older: selectedOlder.length };
}
