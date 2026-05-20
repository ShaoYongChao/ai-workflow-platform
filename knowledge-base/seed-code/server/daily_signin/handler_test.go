package daily_signin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
)

// ── Mock SignInService ──────────────────────────────────────
type MockSignInService struct {
	mock.Mock
}

func (m *MockSignInService) GetStatus(ctx context.Context, playerID string) (*SignInStatus, error) {
	args := m.Called(ctx, playerID)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*SignInStatus), args.Error(1)
}

func (m *MockSignInService) Claim(ctx context.Context, req ClaimRequest) (*ClaimResponse, error) {
	args := m.Called(ctx, req)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*ClaimResponse), args.Error(1)
}

// ── GetStatus 测试 ──────────────────────────────────────────
func TestGetStatus_Success(t *testing.T) {
	svc := new(MockSignInService)
	svc.On("GetStatus", mock.Anything, "player_001").Return(&SignInStatus{
		ClaimedToday: false,
		Streak:       3,
	}, nil)

	h := NewHandler(svc, zapNop())
	req := httptest.NewRequest(http.MethodGet, "/signin/status?player_id=player_001", nil)
	w := httptest.NewRecorder()

	h.GetStatus(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var resp map[string]interface{}
	json.NewDecoder(w.Body).Decode(&resp)
	assert.Equal(t, float64(0), resp["code"])
}

func TestGetStatus_MissingPlayerID(t *testing.T) {
	h := NewHandler(new(MockSignInService), zapNop())
	req := httptest.NewRequest(http.MethodGet, "/signin/status", nil)
	w := httptest.NewRecorder()

	h.GetStatus(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// ── Claim 测试 ──────────────────────────────────────────────
func TestClaim_Success(t *testing.T) {
	svc := new(MockSignInService)
	svc.On("Claim", mock.Anything, ClaimRequest{PlayerID: "player_001"}).
		Return(&ClaimResponse{Success: true, Streak: 1, Message: "签到成功"}, nil)

	h := NewHandler(svc, zapNop())
	body, _ := json.Marshal(ClaimRequest{PlayerID: "player_001"})
	req := httptest.NewRequest(http.MethodPost, "/signin/claim", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Claim(w, req)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestClaim_AlreadyClaimed(t *testing.T) {
	svc := new(MockSignInService)
	svc.On("Claim", mock.Anything, mock.Anything).Return(nil, ErrAlreadyClaimed)

	h := NewHandler(svc, zapNop())
	body, _ := json.Marshal(ClaimRequest{PlayerID: "player_001"})
	req := httptest.NewRequest(http.MethodPost, "/signin/claim", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	h.Claim(w, req)
	assert.Equal(t, http.StatusConflict, w.Code)
}

func TestClaim_InvalidBody(t *testing.T) {
	h := NewHandler(new(MockSignInService), zapNop())
	req := httptest.NewRequest(http.MethodPost, "/signin/claim", bytes.NewReader([]byte("not json")))
	w := httptest.NewRecorder()

	h.Claim(w, req)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

// ── 辅助 ────────────────────────────────────────────────────
func zapNop() *zap.Logger { return zap.NewNop() }
