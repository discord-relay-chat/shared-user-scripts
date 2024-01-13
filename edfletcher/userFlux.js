// Requires constants.MESSAGE_COUNT be set. For every MESSAGE_COUNT messages
// seen, user flux stats will be emitted to the script/bot channel

/* globals DRCUserScript, sendToBotChan, util */

const { eventName, constants, data } = DRCUserScript;
const events = ['irc:quit', 'irc:join', 'irc:part', 'irc:kick', 'irc:ban'];

if (events.includes(eventName)) {
    const state = await DRCUserScript.state.get();

    if (!state.events) {
        state.events = {};
    }

    if (!state.last) {
        state.last = events.reduce((a, ev) => ({ [ev]: 0, ...a }), {});
    }

    if (!state.events[eventName]) {
        state.events[eventName] = 0;
    }

    state.events[eventName]++;
    const totals = Object.values(state.events).reduce((a, x) => a + x);
    const limit = constants.MESSAGE_COUNT || 1000;

    if (!(totals % limit)) {
        const dur = util.fmtDuration(state.lastAnnounce);
        sendToBotChan(`${limit} user-flux events over ${dur} (${totals} total):\n` +
            Object.entries(state.events).map(([name, count]) => {
                const d = count - state.last[name];
                return `* \`${name}\` (${count} / ${d > 0 ? '+' : ''}${d})`;
            }).join('\n'));
        state.last = { ...state.events };
        state.events = null;
        state.lastAnnounce = new Date();
    }

    if (!state?.lastAnnounce) {
        state.lastAnnounce = new Date();
    }

    if (data?.message === "K-Lined") {
        sendToBotChan(`\`${data.nick} <${data.ident}@${data.hostname}>\` k-lined at ${data.tags?.time}`);
    }
    
    state.lastTotal = totals;
    await DRCUserScript.state.set(state);
}