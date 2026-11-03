import { t } from "@/i18n";

/** Only the controller's generated diagnostics enter this presentation map. */
export function voiceControllerErrorLabel(message: string | undefined): string | undefined {
  switch (message) {
    case "The call could not be fully closed. Retry ending it before starting another call.": return t("oct19Voice.theCallCouldNotBeFully_ika2k9");
    case "Speko needs credits before starting a call. Add credits in Speko, then try again.": return t("oct19Voice.spekoNeedsCreditsBeforeStartingA_6kln3g");
    case "The previous call was closed. Start voice again to reconnect; your task is preserved.": return t("oct19Voice.thePreviousCallWasClosedStart_j5wtcx");
    case "Voice could not connect. Check microphone permissions and your connection, then try again.": return t("oct19Voice.voiceCouldNotConnectCheckMicrophone_1gl6vfr");
    case "Microphone state could not be changed. Try again or end the call.": return t("oct19Voice.microphoneStateCouldNotBeChanged_1kntrc5");
    case "A task update could not be delivered to voice. Open the task to read it.": return t("oct19Voice.aTaskUpdateCouldNotBe_1bg1rce");
    case "The answer could not be repeated. Open the task to read it.": return t("oct19Voice.theAnswerCouldNotBeRepeated_16qqzax");
    case "Audio playback is blocked. Check this browser’s sound settings.": return t("oct19Voice.audioPlaybackIsBlockedCheckThis_aqgp72");
    default: return message;
  }
}
