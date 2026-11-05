import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defense: a render-time crash anywhere in the tree shows
 * a recoverable fallback instead of a white screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In a larger app this would go to an error tracker (Sentry et al).
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="error-fallback" role="alert">
          <h1>Something went wrong</h1>
          <p className="muted">
            The interface hit an unexpected error. Your data is safe on the server.
          </p>
          <pre className="error-fallback-details">{this.state.error.message}</pre>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload the app
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
