const messages = {
  ko: {
    microphonesUnavailable: "마이크 목록을 불러올 수 없습니다", microphonesEmpty: "마이크를 찾을 수 없습니다",
    microphone: "마이크", defaultMicrophone: "기본 마이크", note: "노트", meeting: "녹음",
    cancel: "취소", pause: "일시 정지", resume: "재개", done: "완료", mix: "혼합", micOnly: "마이크만",
  },
  en: {
    microphonesUnavailable: "Microphone list unavailable", microphonesEmpty: "No microphones found",
    microphone: "Microphone", defaultMicrophone: "Default microphone", note: "Note", meeting: "Meeting",
    cancel: "Cancel", pause: "Pause", resume: "Resume", done: "Done", mix: "Mix", micOnly: "Mic only",
  },
};
export function recorderText(locale: string, key: keyof typeof messages.en): string {
  return messages[locale.toLowerCase().startsWith("ko") ? "ko" : "en"][key];
}
