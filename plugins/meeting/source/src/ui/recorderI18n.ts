const messages = {
  ko: {
    microphonesUnavailable: "마이크 목록을 불러올 수 없습니다", microphonesEmpty: "마이크를 찾을 수 없습니다",
    microphone: "마이크", defaultMicrophone: "기본 마이크", note: "노트", meeting: "녹음",
    loadFailed: "녹음 화면을 불러오지 못했습니다.",
    recorderView: "녹음 보기", captureMode: "캡처 모드", chooseMicrophone: "마이크 선택",
    starting: "녹음 시작 중…", capturingMix: "🔊 + 🎤 시스템 오디오 + 마이크", microphoneOnly: "🎤 마이크만", capturingMic: "🎤 마이크만 캡처 중",
    notesEmpty: "회의 요약이 아직 생성되지 않았습니다.\n몇 분간 대화가 누적되면 자동으로 표시됩니다.", analyzing: "분석 중…",
    quotaError: "OpenAI 한도 초과 — STT 일시 중단. platform.openai.com 에서 결제/한도 확인이 필요합니다.",
    authError: "OpenAI 인증 실패 — 설정에서 API 키를 확인해주세요.", networkError: "네트워크 오류 — STT 호출 실패. 잠시 후 자동 재시도.",
    sttError: "STT 오류", pauseDenied: "녹음 상태 변경이 거부되었습니다.", changingDevice: "장치 변경 중…",
    startRefused: "녹음을 시작할 수 없습니다.", restartRefused: "녹음을 다시 시작할 수 없습니다.",
    sessionMissing: "sessionId 없음", noSession: "표시할 세션이 없습니다", requestFailed: "요청이 거부되었거나 실패했습니다.",
    cancel: "취소", pause: "일시 정지", resume: "재개", done: "완료", mix: "혼합", micOnly: "마이크만",
  },
  en: {
    microphonesUnavailable: "Microphone list unavailable", microphonesEmpty: "No microphones found",
    microphone: "Microphone", defaultMicrophone: "Default microphone", note: "Note", meeting: "Meeting",
    loadFailed: "Unable to load the recorder.",
    recorderView: "Recorder view", captureMode: "Capture mode", chooseMicrophone: "Choose microphone",
    starting: "Starting recording…", capturingMix: "🔊 + 🎤 System audio + microphone", microphoneOnly: "🎤 Microphone only", capturingMic: "🎤 Capturing microphone only",
    notesEmpty: "No meeting summary yet.\nIt will appear automatically after a few minutes of conversation.", analyzing: "Analyzing…",
    quotaError: "OpenAI quota exceeded — STT paused. Check billing and limits at platform.openai.com.",
    authError: "OpenAI authentication failed — check the API key in settings.", networkError: "Network error — STT failed. Retrying shortly.",
    sttError: "STT error", pauseDenied: "Recording state change was denied.", changingDevice: "Changing device…",
    startRefused: "Unable to start recording.", restartRefused: "Unable to restart recording.",
    sessionMissing: "Missing sessionId", noSession: "No session to display", requestFailed: "The request was denied or failed.",
    cancel: "Cancel", pause: "Pause", resume: "Resume", done: "Done", mix: "Mix", micOnly: "Mic only",
  },
};
export function recorderText(locale: string, key: keyof typeof messages.en): string {
  return messages[locale.toLowerCase().startsWith("ko") ? "ko" : "en"][key];
}
