import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import Shows from './pages/Shows';
import ShowDetail from './pages/ShowDetail';
import Orders from './pages/Orders';
import Admin from './pages/Admin';
import Login from './pages/Login';
import { api, getSession, saveSession } from './api';

function AuthBar() {
  const [, force] = useState(0);
  const navigate = useNavigate();
  const session = getSession();

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // 会话已失效也继续本地退出
    }
    saveSession(null);
    force((n) => n + 1);
    navigate('/shows');
  };

  if (!session) {
    return (
      <span className="authbar">
        <NavLink to="/login" data-testid="go-login">登录</NavLink>
      </span>
    );
  }
  return (
    <span className="authbar" data-testid="current-user">
      当前：{session.user.id}（{session.user.role === 'staff' ? '工作人员' : '用户'}）
      <button className="link" data-testid="logout-button" onClick={logout}>退出</button>
    </span>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🎫 票务锁座与分账台</div>
        <nav>
          <NavLink to="/shows">场次购票</NavLink>
          <NavLink to="/orders">我的订单</NavLink>
          <NavLink to="/admin">工作人员台</NavLink>
        </nav>
        <AuthBar />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/shows" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/shows" element={<Shows />} />
          <Route path="/shows/:showId" element={<ShowDetail />} />
          <Route path="/orders" element={<Orders />} />
          <Route path="/admin" element={<Admin />} />
        </Routes>
      </main>
    </div>
  );
}
