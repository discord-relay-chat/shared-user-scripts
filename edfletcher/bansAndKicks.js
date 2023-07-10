/* globals DRCUserScript, sendToBotChan */

const { data, eventName } = DRCUserScript;

if ((eventName === "irc:ban" || eventName === "irc:kick") &&
    JSON.stringify(data).indexOf("##fix_your_connection") === -1) {
    if (data.raw_modes) {
      if (data.raw_modes?.indexOf("+b") > -1) {
        sendToBotChan(`**${data.raw_params?.[0]}** banned in ${data.target} (by ${data.nick})`);
      }
      if (data.raw_modes?.indexOf("+q") > -1) {
        sendToBotChan(`**${data.raw_params?.[0]}** quieted in ${data.target} (by ${data.nick})`);
      }
    }
    else if (data.kicked) {
      sendToBotChan(`**${data.kicked}** kicked from ${data.channel} (by ${data.nick}): "${data.message}"`)
    }
    else {
      sendToBotChan(data);
    }
}
