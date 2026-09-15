import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, saveSession } from '../api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(username.trim(), password);
      saveSession(session);
      navigate('/shows');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <h1>登录</h1>
      <p className="muted">演示账号：alice / alice123（用户），bob / bob123（用户），admin / admin123（工作人员）</p>
      {error && (
        <div className="banner error" data-testid="login-error">{error}</div>
      )}
      <label className="field">
        用户名
        <input
          data-testid="login-username"
          value={username}
          autoComplete="username"
          onChange={(e) => setUsername(e.target.value)}
        />
      </label>
      <label className="field">
        密码
        <input
          data-testid="login-password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </label>
      <button className="primary" data-testid="login-submit" disabled={busy || !username || !password} onClick={submit}>
        登录
      </button>
    </div>
  );
}
