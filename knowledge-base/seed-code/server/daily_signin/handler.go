package daily_signin

import (
	"encoding/json"
	"errors"
	"net/http"

	"go.uber.org/zap"
)

// Handler HTTP 处理层（只做参数校验和响应格式化）
type Handler struct {
	service SignInServicer
	logger  *zap.Logger
}

// NewHandler 构造函数
func NewHandler(service SignInServicer, logger *zap.Logger) *Handler {
	return &Handler{service: service, logger: logger}
}

// RegisterRoutes 注册路由
func (h *Handler) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/signin/status", h.GetStatus)
	mux.HandleFunc("/signin/claim", h.Claim)
}

// GetStatus GET /signin/status?player_id=xxx
func (h *Handler) GetStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}

	playerID := r.URL.Query().Get("player_id")
	if playerID == "" {
		writeError(w, http.StatusBadRequest, "missing_param", "player_id 不能为空")
		return
	}

	status, err := h.service.GetStatus(r.Context(), playerID)
	if err != nil {
		h.logger.Error("GetStatus failed", zap.String("playerID", playerID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "internal_error", "")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{Code: 0, Data: status, Msg: "ok"})
}

// Claim POST /signin/claim
func (h *Handler) Claim(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}

	var req ClaimRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "请求体格式错误")
		return
	}
	if req.PlayerID == "" {
		writeError(w, http.StatusBadRequest, "missing_param", "player_id 不能为空")
		return
	}

	resp, err := h.service.Claim(r.Context(), req)
	if err != nil {
		if IsAlreadyClaimed(err) {
			writeError(w, http.StatusConflict, "already_claimed", "今日签到奖励已领取")
			return
		}
		h.logger.Error("Claim failed", zap.String("playerID", req.PlayerID), zap.Error(err))
		writeError(w, http.StatusInternalServerError, "internal_error", "")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{Code: 0, Data: resp, Msg: "ok"})
}

// ── 响应工具函数 ────────────────────────────────────────────

type apiResponse struct {
	Code int         `json:"code"`
	Data interface{} `json:"data,omitempty"`
	Msg  string      `json:"msg"`
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	if msg == "" {
		msg = http.StatusText(status)
	}
	writeJSON(w, status, apiResponse{Code: status, Msg: msg})
}

// ── 确保编译期接口实现验证 ──────────────────────────────────
var _ SignInServicer = (*SignInService)(nil)
