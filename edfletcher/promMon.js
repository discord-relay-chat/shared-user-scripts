// A simple user script to scrape a Prometheus (https://prometheus.io/) server 
// and post to the bot/script channel any alerts that are currently firing.
//
// Requires the followings constants be set:
//  * PROM_MON_CHECK_FREQ_MINS: scrape frequency, in minutes
//  * PROM_MON_FQDN: the fully qualified name (including protocol) of your Prometheus server, e.g. http://localhost:9090

/* globals DRCUserScript, util, sendToBotChan */
const { constants, state } = DRCUserScript;

async function main() {
    const lastUpdate = Number(new Date());
    const curState = await state.get() ?? { lastUpdate: 0 };

    if (lastUpdate - curState.lastUpdate < constants.PROM_MON_CHECK_FREQ_MINS * 60 * 1000) {
        return;
    }

    await state.set({ lastUpdate });

    const monRes = await fetch(`${constants.PROM_MON_FQDN}/api/v1/rules`);
    if (!monRes.ok) {
        sendToBotChan(`Request failed!`);
        sendToBotChan(monRes);
        return;
    }

    const resJson = await monRes.json();

    if (resJson.status !== "success" || !resJson.data?.groups) {
        sendToBotChan(`Check failed!`);
        sendToBotChan(resJson);
        return;
    }

    resJson.data.groups
        .filter((group) => group?.rules.some(({ state }) => state === "firing"))
        .flatMap(({ rules }) => rules)
        .forEach(({ alerts }) => alerts
            .filter(({ state }) => state === "firing")
            .forEach(({ activeAt, annotations: { summary } }) => {
                const activeAtDate = new Date(activeAt);
                sendToBotChan(`# Alert!\n\n## ${summary}\n` +
                    `Started firing **${util.fmtDuration(activeAtDate)} ago**\n` +
                    `_at ${activeAtDate}_`)
            })
        );
}

await main();