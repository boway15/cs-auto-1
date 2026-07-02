import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** 捕获子路由渲染错误，避免整页白屏 */
export default class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[RouteErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-1 h-full min-h-[240px] items-center justify-center p-8">
          <div className="text-center space-y-4 max-w-md">
            <h2 className="text-lg font-semibold">页面加载出错</h2>
            <p className="text-sm text-muted-foreground break-words">
              {this.state.error.message || "未知错误"}
            </p>
            <Button type="button" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
