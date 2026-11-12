[README.md](https://github.com/user-attachments/files/34738700/README.md)
# SmartShade 대시보드 ↔ ESP32 연동

```
web/                 대시보드 (index.html · style.css · script.js)
esp32_B_tracking/    ESP32-B 태양 추적 펌웨어 (Rev.3 회로도 기준, 새로 작성)
seat_controller/     ESP32-C 좌판 — 기존 코드 + 통신만 추가 (제어 로직은 그대로)
esp32_A_link/        ESP32-A 롤러 — 통신 템플릿 (A 원본 코드에 붙여 넣기)
```
B·C·A 템플릿 모두 Arduino-ESP32 3.0.7에서 컴파일 확인. 필요한 라이브러리: **ArduinoJson 7.x**, **BH1750 (Christopher Laws)**, Adafruit SHT31.

## 1. 전시장에서 실행 (유선)
1. 노트북에 ESP32 3개를 USB로 연결 (Arduino 시리얼 모니터는 반드시 닫기)
2. `web` 폴더에서 `python -m http.server 8000` → **Chrome/Edge**로 `http://localhost:8000`
3. **보드 연결(USB)** 을 세 번 눌러 포트를 하나씩 허용 → 보드가 보낸 `"id"`로 A/B/C가 자동 구분됨
4. 다음부터는 페이지만 열면 자동 연결. 케이블을 다시 꽂아도 자동 재연결
5. 연결 안 된 보드는 **SIM**(화면 시뮬레이션)으로 동작 → 하드웨어 일부가 고장 나도 시연 가능

## 2. 통신 규약 (유선·무선 공통)
115200 bps, **한 줄 = JSON 하나** (`\n`으로 끝). JSON이 아닌 줄은 기록창에 글자 그대로 표시.

| 보드 | PC → 보드 | 보드 → PC (텔레메트리) |
|---|---|---|
| B 추적 | `x_jog{deg}` `x_goto{az}` `x_zero{az}` `z_jog{deg}` `z_goto{deg}` `z_zero{deg}` `stop` | 200 ms: `x.az/tgt/moving`, `z.deg/tgt`, `lux[N,E,S,W]` |
| A 롤러 | `roller{n,dir,ms}` `roller_stop{n}` `stop` | 200 ms: `r[].enc/run/pct`, `wind` |
| C 좌판 | `mode{value:COOL/HEAT/OFF}` `fault_reset` `stop` | 1 s: 좌판 3점·방열부 2점·외기·습도·이슬점·목표·duty·팬·배터리·래치 |
| 공통 | `ping`(0.5 s마다) `hello` | 이벤트 `{"id":..,"ev":"info/warn/error","msg":..}` |

**안전 워치독:** A·B는 1.5 s 동안 명령(ping 포함)을 못 받으면 모터를 멈춘다. 브라우저를 닫거나 케이블이 빠져도 계속 돌지 않는다. C는 PC 연결과 무관하게 스스로 안전 판단을 한다.

## 3. 시운전 때 실측해서 고칠 값 (`esp32_B_tracking.ino` 상단)
- `X_PULSE_PER_REV` — DM542 마이크로스텝 DIP 설정과 같게
- `X_GEAR_RATIO` — 모터 ↔ 회전판 감속비
- `Z_DEG_PER_S` — Z축을 `Z_DUTY`로 10 s 돌려 각도 변화 ÷ 10
- `X_DIR_CW`, `Z_DIR_UP` — 버튼 방향과 실제 방향이 반대면 반전
- `script.js`의 `CFG.tiltFromElevation` — 틸트 0°가 '수평'이 아니면 수정

## 4. 나중에 Wi-Fi로 바꿀 때
대시보드에는 WebSocket 연결(`ws://IP:81`)이 이미 들어 있다. 펌웨어는 `linkSend()`(송신)와 `pollSerial()`(수신) 두 곳만 WebSocket 서버(예: `WebSocketsServer` 라이브러리)로 바꾸면 되고, JSON 규약은 그대로다.
- Wi-Fi를 켜면 **ADC2 핀(GPIO 0,2,4,12–15,25–27)의 analogRead가 안 된다.** 좌판 NTC는 ADC1(32–36)이라 문제없음. A 보드가 ADC2로 아날로그를 읽는다면 핀을 옮겨야 한다.
