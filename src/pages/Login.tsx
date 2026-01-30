import React, { useState } from 'react';
import { AUTH_STORAGE_KEY, VALID_PASSWORD, VALID_USERNAME } from '../const/appConstants';
import './PDFProcessor.css';

interface LoginProps {
  onAuthenticated: () => void;
}

const Login: React.FC<LoginProps> = ({ onAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const isValid = username === VALID_USERNAME && password === VALID_PASSWORD;
    if (!isValid) {
      setError('Sai tài khoản hoặc mật khẩu.');
      return;
    }

    window.localStorage.setItem(AUTH_STORAGE_KEY, '1');
    setError('');
    onAuthenticated();
  };

  return (
    <div className="login-container">
      <div className="login-card">
        <h1>Đăng nhập</h1>
        <p className="login-subtitle">Vui lòng đăng nhập để tiếp tục xử lý PDF.</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label">
            Tên đăng nhập
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Nhập tên đăng nhập"
              autoComplete="username"
              required
            />
          </label>
          <label className="login-label">
            Mật khẩu
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu"
              autoComplete="current-password"
              required
            />
          </label>
          {error && <div className="error-message" style={{ marginTop: 8 }}>{error}</div>}
          <button type="submit" className="btn-primary login-submit">
            Đăng nhập
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
