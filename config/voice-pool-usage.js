// Count only the currently loaded work's WeChat characters. Reading this list
// must not create automatic voice pins or save any contact changes.
export function sortVoicePoolByUsage(pool, wechatData) {
    const usage = new Map();
    const roles = [...(wechatData?.data?.contacts || []), ...(wechatData?.data?.chats || []).filter(c => c?.type !== 'group')];
    const seenIds = new Set(), seenNames = new Set();
    const normalize = name => String(name || '').replace(/\s+/g, '').toLowerCase();
    for (const role of roles) {
        if (!role || role === wechatData?.data?.userInfo || (role.id && role.id === wechatData?.data?.userInfo?.id)) continue;
        const canonical = (role.contactId ? wechatData.getContact?.(role.contactId) : null)
            || wechatData.findContactByNameLoose?.(role.name, { includeChats: false }) || role;
        const nameKey = normalize(canonical.name || role.name);
        if (!nameKey || seenNames.has(nameKey) || (canonical.id && seenIds.has(canonical.id))) continue;
        seenNames.add(nameKey); if (canonical.id) seenIds.add(canonical.id);
        const voices = canonical.ttsVoices || {};
        const hasVoices = Object.values(voices).some(value => String(value || '').trim());
        const provider = canonical.ttsProvider || wechatData.storage?.get?.('phone-tts-provider') || 'minimax_cn';
        let voice = String(voices.volcengine || (!hasVoices && provider === 'volcengine' ? canonical.ttsVoice || '' : '')).trim();
        if (!voice) {
            const resolved = wechatData.resolveTtsVoiceByName?.(canonical.name, { includeChats: true, persistAutoPick: false });
            if (resolved?.provider === 'volcengine') voice = String(resolved.voice || '').trim();
        }
        if (!voice) continue;
        if (!usage.has(voice)) usage.set(voice, []);
        usage.get(voice).push(wechatData.getContactDisplayName?.(canonical) || canonical.name || role.name);
    }
    return pool.map((item, sourceIndex) => ({ ...item, sourceIndex, usageCount: usage.get(item.id)?.length || 0, usedBy: usage.get(item.id) || [] }))
        .sort((a, b) => a.usageCount - b.usageCount || a.sourceIndex - b.sourceIndex);
}
