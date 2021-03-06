/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import * as path from 'path';
import * as cp from 'child_process';
import { injectable, inject } from 'inversify';
import { ILogger, ConnectionErrorHandler } from '@theia/core/lib/common';
import { Emitter } from '@theia/core/lib/common/event';
import { createIpcEnv } from '@theia/core/lib/node/messaging/ipc-protocol';
import { HostedPluginClient, ServerPluginRunner } from '../../common/plugin-protocol';
import { RPCProtocolImpl } from '../../api/rpc-protocol';
import { MAIN_RPC_CONTEXT } from '../../api/plugin-api';

export interface IPCConnectionOptions {
    readonly serverName: string;
    readonly logger: ILogger;
    readonly args: string[];
    readonly errorHandler?: ConnectionErrorHandler;
}

@injectable()
export class HostedPluginProcess implements ServerPluginRunner {

    @inject(ILogger)
    protected readonly logger: ILogger;

    private childProcess: cp.ChildProcess | undefined;
    private client: HostedPluginClient;

    public setClient(client: HostedPluginClient): void {
        if (this.client) {
            if (this.childProcess) {
                this.runPluginServer();
            }
        }
        this.client = client;
    }

    public setDefault(defaultRunner: ServerPluginRunner): void {

    }

    public acceptMessage(jsonMessage: any): boolean {
        return jsonMessage.type !== undefined && jsonMessage.id;
    }

    public onMessage(jsonMessage: any): void {
        if (this.childProcess) {
            this.childProcess.send(JSON.stringify(jsonMessage));
        }
    }

    public terminatePluginServer(): void {
        const emitter = new Emitter();
        if (this.childProcess === undefined) {
            return;
        }

        this.childProcess.on('message', message => {
            emitter.fire(JSON.parse(message));
        });
        const rpc = new RPCProtocolImpl({
            onMessage: emitter.event,
            send: (m: {}) => {
                if (this.childProcess!.send) {
                    this.childProcess!.send(JSON.stringify(m));
                }
            }
        });
        const hostedPluginManager = rpc.getProxy(MAIN_RPC_CONTEXT.HOSTED_PLUGIN_MANAGER_EXT);
        hostedPluginManager.$stopPlugin('').then(() => {
            emitter.dispose();
            this.childProcess!.kill();
        });
        this.childProcess = undefined;
    }

    public runPluginServer(): void {
        if (this.childProcess) {
            this.terminatePluginServer();
        }
        this.childProcess = this.fork({
            serverName: 'hosted-plugin',
            logger: this.logger,
            args: []
        });
        this.childProcess.on('message', message => {
            if (this.client) {
                this.client.postMessage(message);
            }
        });

    }

    private fork(options: IPCConnectionOptions): cp.ChildProcess {

        // create env and add PATH to it so any executable from root process is available
        const env = createIpcEnv();
        env.PATH = process.env.PATH;

        const forkOptions: cp.ForkOptions = {
            silent: true,
            env: env,
            execArgv: [],
            stdio: ['pipe', 'pipe', 'pipe', 'ipc']
        };
        const inspectArgPrefix = `--${options.serverName}-inspect`;
        const inspectArg = process.argv.find(v => v.startsWith(inspectArgPrefix));
        if (inspectArg !== undefined) {
            forkOptions.execArgv = ['--nolazy', `--inspect${inspectArg.substr(inspectArgPrefix.length)}`];
        }

        const childProcess = cp.fork(path.resolve(__dirname, 'plugin-host.js'), options.args, forkOptions);
        childProcess.stdout.on('data', data => this.logger.info(`[${options.serverName}: ${childProcess.pid}] ${data.toString()}`));
        childProcess.stderr.on('data', data => this.logger.error(`[${options.serverName}: ${childProcess.pid}] ${data.toString()}`));

        this.logger.debug(`[${options.serverName}: ${childProcess.pid}] IPC started`);
        childProcess.once('exit', () => this.logger.debug(`[${options.serverName}: ${childProcess.pid}] IPC exited`));

        return childProcess;
    }
}
