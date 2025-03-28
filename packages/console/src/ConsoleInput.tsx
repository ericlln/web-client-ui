import React, { PureComponent, type ReactElement, type RefObject } from 'react';
import classNames from 'classnames';
import * as monaco from 'monaco-editor';
import Log from '@deephaven/log';
import {
  assertNotNull,
  type CancelablePromise,
  PromiseUtils,
} from '@deephaven/utils';
import { type ViewportData } from '@deephaven/storage';
import type { dh } from '@deephaven/jsapi-types';
import {
  type CommandHistoryStorage,
  type CommandHistoryStorageItem,
  type CommandHistoryTable,
} from './command-history';
import { MonacoProviders, MonacoTheme, MonacoUtils } from './monaco';
import './ConsoleInput.scss';

const log = Log.module('ConsoleInput');

const LINE_HEIGHT = parseInt(MonacoTheme['line-height'], 10);
const TOP_PADDING = 6;
const BOTTOM_PADDING = 6;
const MIN_INPUT_HEIGHT = LINE_HEIGHT + TOP_PADDING + BOTTOM_PADDING;
const BUFFER_SIZE = 100;

interface ConsoleInputProps {
  session: dh.IdeSession;
  language: string;
  scope?: string;
  commandHistoryStorage: CommandHistoryStorage;
  onSubmit: (command: string) => void;
  maxHeight?: number;
  disabled?: boolean;
}

interface ConsoleInputState {
  commandEditorHeight: number;
  isFocused: boolean;
  model: monaco.editor.ITextModel | null;
}

/**
 * Component for input in a console session. Handles loading the recent command history
 */
export class ConsoleInput extends PureComponent<
  ConsoleInputProps,
  ConsoleInputState
> {
  static defaultProps = {
    maxHeight: LINE_HEIGHT * 10,
    scope: null,
    disabled: false,
  };

  static INPUT_CLASS_NAME = 'console-input';

  constructor(props: ConsoleInputProps) {
    super(props);

    this.handleResize = this.handleResize.bind(this);

    this.commandContainer = React.createRef();
    this.commandHistoryIndex = null;
    this.timestamp = Date.now();
    this.bufferIndex = 0;
    this.history = [];
    // Tracks every command that has been modified by its commandHistoryIndex. Cleared on any command being executed
    this.modifiedCommands = new Map();
    this.resizeObserver = new window.ResizeObserver(this.handleResize);

    this.state = {
      commandEditorHeight: LINE_HEIGHT,
      isFocused: false,
      model: null,
    };
  }

  componentDidMount(): void {
    this.initCommandEditor();

    this.loadMoreHistory();
  }

  componentDidUpdate(): void {
    this.layoutEditor();
  }

  componentWillUnmount(): void {
    this.resizeObserver.disconnect();

    if (this.loadingPromise != null) {
      this.loadingPromise.cancel();
    }

    this.destroyCommandEditor();
  }

  cancelListener?: () => void;

  resizeObserver: ResizeObserver;

  commandContainer: RefObject<HTMLDivElement>;

  commandEditor?: monaco.editor.IStandaloneCodeEditor;

  commandHistoryIndex: number | null;

  commandSuggestionContainer?: Element | null;

  loadingPromise?:
    | CancelablePromise<ViewportData<CommandHistoryStorageItem>>
    | CancelablePromise<CommandHistoryTable>;

  timestamp: number;

  bufferIndex: number | null;

  history: string[];

  // Tracks every command that has been modified by its commandHistoryIndex. Cleared on any command being executed
  modifiedCommands: Map<number | null, string | null>;

  /**
   * Sets the console text from an external source.
   * Sets commandHistoryIndex to null since the source is not part of the history
   * @param text The text to set in the input
   * @param focus If the input should be focused
   * @param execute If the input should be executed
   * @returns void
   */
  setConsoleText(text: string, focus = true, execute = false): void {
    if (!text) {
      return;
    }

    log.debug('Command received: ', text);

    // Only set the console text if we're not running this command
    if (!execute) {
      // Need to set commandHistoryIndex before value
      // On value change, modified commands map updates
      this.commandHistoryIndex = null;
      this.commandEditor?.setValue(text);
    }

    if (focus) {
      this.focusEnd();
    }

    this.updateDimensions();

    if (execute) {
      this.processCommand(text);
    }
  }

  initCommandEditor(): void {
    const { language, session } = this.props;
    const model = monaco.editor.createModel(
      '',
      language,
      MonacoUtils.generateConsoleUri()
    );
    const commandSettings = {
      copyWithSyntaxHighlighting: false,
      cursorStyle: 'block',
      fixedOverflowWidgets: true,
      folding: false,
      fontFamily: 'Fira Mono',
      glyphMargin: false,
      language,
      lineHeight: LINE_HEIGHT,
      lineDecorationsWidth: 3,
      lineNumbers: 'off',
      minimap: { enabled: false },
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      scrollbar: {
        arrowSize: 0,
        horizontal: 'hidden',
        horizontalScrollbarSize: 0,
      },
      padding: {
        top: TOP_PADDING,
        bottom: BOTTOM_PADDING,
      },
      value: '',
      wordWrap: 'on',
      autoClosingBrackets: 'beforeWhitespace',
      model,
    } as const;

    const element = this.commandContainer.current;
    assertNotNull(element);

    this.commandEditor = monaco.editor.create(element, commandSettings);

    MonacoUtils.setEOL(this.commandEditor);
    MonacoUtils.openDocument(this.commandEditor, session);

    this.commandEditor.onDidChangeModelContent(() => {
      const value = this.commandEditor?.getValue();
      this.modifiedCommands.set(this.commandHistoryIndex, value ?? null);
      this.updateDimensions();
    });

    this.commandEditor.onDidFocusEditorText(() => {
      this.setState({ isFocused: true });
    });

    this.commandEditor.onDidBlurEditorText(() => {
      this.setState({ isFocused: false });
    });

    /**
     * Register for keydown events to capture the `Enter` key.
     * Need to do it this way instead of using `addCommand`, because that would eat the Enter key in all situations, which is not what we want.
     * Can't do it in `onDidChangeModelContent` either, since we want to stop the Enter action from modifying the command.
     */
    this.commandEditor.onKeyDown(keyEvent => {
      const { commandEditor, commandHistoryIndex } = this;
      const position = commandEditor?.getPosition();
      assertNotNull(position);
      const { lineNumber } = position;

      if (!keyEvent.altKey && !keyEvent.shiftKey && !keyEvent.metaKey) {
        if (
          keyEvent.code === 'ArrowUp' &&
          !this.isSuggestionMenuPopulated() &&
          lineNumber === 1
        ) {
          if (commandHistoryIndex != null) {
            this.loadCommand(commandHistoryIndex + 1);
          } else {
            this.loadCommand(0);
          }

          this.focusStart();
          keyEvent.stopPropagation();
          keyEvent.preventDefault();

          return;
        }

        if (
          keyEvent.code === 'ArrowDown' &&
          !this.isSuggestionMenuPopulated() &&
          lineNumber === model?.getLineCount()
        ) {
          if (commandHistoryIndex != null && commandHistoryIndex > 0) {
            this.loadCommand(commandHistoryIndex - 1);
          } else {
            this.loadCommand(null);
          }

          this.focusEnd();
          keyEvent.stopPropagation();
          keyEvent.preventDefault();

          return;
        }

        if (
          keyEvent.keyCode === monaco.KeyCode.Enter &&
          !this.isSuggestionMenuPopulated()
        ) {
          keyEvent.stopPropagation();
          keyEvent.preventDefault();

          const command = this.commandEditor?.getValue().trim();
          if (command !== undefined) {
            this.processCommand(command);
            this.commandEditor?.setValue('');
          }
        }
      }
    });

    // Disable the Ctrl+F functionality so that the find window doesn't appear
    MonacoUtils.disableKeyBindings(this.commandEditor, [
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, // eslint-disable-line no-bitwise
    ]);

    MonacoUtils.registerPasteHandler(this.commandEditor);

    this.commandEditor.focus();

    this.resizeObserver.observe(element);

    this.updateDimensions();

    this.setState({ model: this.commandEditor.getModel() });
  }

  destroyCommandEditor(): void {
    const { session } = this.props;
    if (this.commandEditor) {
      MonacoUtils.closeDocument(this.commandEditor, session);
      this.commandEditor.dispose();
      this.commandEditor = undefined;
    }
  }

  handleResize(): void {
    this.updateDimensions();
  }

  isSuggestionMenuActive(): boolean {
    if (!this.commandSuggestionContainer) {
      this.commandSuggestionContainer = this.commandEditor
        ?.getDomNode()
        ?.querySelector('.suggest-widget');
    }

    return (
      (this.commandSuggestionContainer &&
        this.commandSuggestionContainer.classList.contains('visible')) ??
      false
    );
  }

  isSuggestionMenuPopulated(): boolean {
    return (
      this.isSuggestionMenuActive() &&
      (this.commandSuggestionContainer?.querySelector('.monaco-list-rows')
        ?.childElementCount ?? 0) > 0
    );
  }

  focus(): void {
    this.commandEditor?.focus();
  }

  focusStart(): void {
    const model = this.commandEditor?.getModel();
    assertNotNull(model);
    const column = model.getLineLength(1) + 1; // Length of 1st line
    const firstCharTop = this.commandEditor?.getTopForPosition(1, column);
    assertNotNull(firstCharTop);
    this.commandEditor?.setPosition({ lineNumber: 1, column });
    this.commandEditor?.setScrollTop(firstCharTop);
    this.commandEditor?.focus();
  }

  focusEnd(): void {
    const model = this.commandEditor?.getModel();
    assertNotNull(model);
    const lastLine = model.getLineCount();
    const column = model.getLineLength(lastLine) + 1;
    const lastCharTop = this.commandEditor?.getTopForPosition(lastLine, column);
    assertNotNull(lastCharTop);
    this.commandEditor?.setPosition({ lineNumber: lastLine, column });
    this.commandEditor?.setScrollTop(lastCharTop);
    this.commandEditor?.focus();
  }

  clear(): void {
    this.commandEditor?.focus();
    this.commandEditor?.getModel()?.setValue('');
    this.commandHistoryIndex = null;
  }

  layoutEditor(): void {
    if (this.commandEditor) {
      this.commandEditor.layout();
    }
  }

  /**
   * Loads the given command from history
   * If edits have been made to the command since last run command, loads the modified version
   * @param index The index to load. Null to load command started in the editor and not in the history
   */
  loadCommand(index: number | null): void {
    if (index !== null && index >= this.history.length) {
      return;
    }

    const modifiedValue = this.modifiedCommands.get(index);
    const historyValue =
      index === null ? '' : this.history[this.history.length - index - 1];

    this.commandHistoryIndex = index;
    this.commandEditor?.getModel()?.setValue(modifiedValue ?? historyValue);

    if (index !== null && index > this.history.length - BUFFER_SIZE) {
      this.loadMoreHistory();
    }
  }

  async loadMoreHistory(): Promise<void> {
    try {
      if (this.loadingPromise != null || this.bufferIndex == null) {
        return;
      }

      const { commandHistoryStorage, language, scope } = this.props;

      this.loadingPromise = PromiseUtils.makeCancelable(
        commandHistoryStorage.getTable(language, scope ?? '', this.timestamp),
        resolved => resolved.close()
      );

      const table = await this.loadingPromise;
      table.setReversed(true);
      table.setViewport({
        top: this.bufferIndex,
        bottom: this.bufferIndex + BUFFER_SIZE - 1,
      });

      this.loadingPromise = PromiseUtils.makeCancelable(
        table.getViewportData(),
        () => table.close()
      );
      const viewportData = await this.loadingPromise;
      this.bufferIndex += BUFFER_SIZE;
      if (this.bufferIndex >= table.size) {
        // We've loaded the full history, no need to load any more
        this.bufferIndex = null;
      }
      this.history = [
        ...viewportData.items
          .filter(
            ({ name }, pos, arr) => pos === 0 || name !== arr[pos - 1].name
          )
          .map(({ name }) => name)
          .reverse(),
        ...this.history,
      ];

      this.loadingPromise = undefined;

      table.close();
    } catch (err) {
      this.loadingPromise = undefined;
      if (PromiseUtils.isCanceled(err)) {
        log.debug2('Promise canceled, not loading history');
        return;
      }

      log.error('Error fetching history', err);
    }
  }

  processCommand(command: string): void {
    this.commandHistoryIndex = null;
    this.modifiedCommands.clear();

    assertNotNull(command);
    if (
      command !== '' &&
      (this.history.length === 0 ||
        command !== this.history[this.history.length - 1])
    ) {
      this.history.push(command);
    }
    this.updateDimensions();

    const { onSubmit } = this.props;
    onSubmit(command);
  }

  updateDimensions(): void {
    if (!this.commandEditor) {
      return;
    }

    const { maxHeight } = this.props;
    assertNotNull(maxHeight);
    const contentHeight = this.commandEditor.getContentHeight();
    const commandEditorHeight = Math.max(
      Math.min(contentHeight, maxHeight),
      MIN_INPUT_HEIGHT
    );

    // Only show the overview ruler (markings overlapping sroll bar area) if the scrollbar will show
    const shouldScroll = contentHeight > commandEditorHeight;

    const options = { overviewRulerLanes: shouldScroll ? undefined : 0 };

    this.setState(
      {
        commandEditorHeight,
      },
      () => {
        this.commandEditor?.updateOptions(options);
        this.commandEditor?.layout();
      }
    );
  }

  render(): ReactElement {
    const { disabled, language, session } = this.props;
    const { commandEditorHeight, isFocused, model } = this.state;
    return (
      <div className={classNames('console-input-wrapper', { disabled })}>
        <div
          className={classNames('console-input-inner-wrapper', {
            focus: isFocused,
          })}
        >
          <div
            className={ConsoleInput.INPUT_CLASS_NAME}
            ref={this.commandContainer}
            style={{ height: commandEditorHeight }}
          />
          {model && (
            <MonacoProviders
              model={model}
              language={language}
              session={session}
            />
          )}
        </div>
      </div>
    );
  }
}

export default ConsoleInput;
