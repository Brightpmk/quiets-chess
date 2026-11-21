import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component<React.PropsWithChildren, {error: string}> {
  state = {error: ''};
  static getDerivedStateFromError(error: Error) { return {error: error.message}; }
  render() {
    return this.state.error ? <main className="fatal"><h1>Something went wrong</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Reload analysis board</button></main> : this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);
