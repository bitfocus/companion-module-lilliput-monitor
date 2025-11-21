const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const { combineRgb } = require('@companion-module/base')
const LilliputD = require('lilliput-monitor')
const UpgradeScripts = require('./upgrades.js')
const { PassThrough } = require('stream')

class LilliputMonitorInstance extends InstanceBase {
	processLilliputDData(data) {
		return data.dev.command.reduce(function (map, obj) {
			if (!(obj.value === undefined) && obj.value) {
				let values = obj.value
				if (!Array.isArray(values)) {
					values = [{ name: obj.name, item: values.item }]
				}
				map[obj.name] = values.reduce(function (valueArray, valueObj) {
					let valueMap = {}
					if ('name' in valueObj) {
						valueMap['name'] = valueObj.name
						if ('item' in valueObj) {
							valueMap['values'] = Array.from(valueObj.item).map((item) => item.name)
						} else {
							valueMap['values'] = []
						}
						valueArray.push(valueMap)
					}
					return valueArray
				}, [])
			} else {
				map[obj.name] = undefined
			}
			return map
		}, {})
	}

	generateChoices(data, command, value) {
		const items = data[command].find((element) => element.name == value)
		if (items && items.values) {
			var choices = []
			items.values.forEach((choice) => {
				choices.push({ id: choice, label: choice.charAt(0).toUpperCase() + choice.slice(1) })
			})
			return choices
		} else {
			return []
		}
	}

	init(config) {
		this.config = config
		this.DATA = {}
		this.udp = undefined

		this.CHOICES_ON_OFF = [
			{ id: 'off', label: 'Off' },
			{ id: 'on', label: 'On' },
		]

		this.CHOICES_0_100 = [
			{ id: '0', label: '0' },
			{ id: '25', label: '25' },
			{ id: '50', label: '50' },
			{ id: '75', label: '75' },
			{ id: '100', label: '100' },
		]

		this.CHOICES_VOLUME = this.CHOICES_0_100
		this.CHOICES_BRIGHTNESS = this.CHOICES_0_100
		this.CHOICES_CONTRAST = this.CHOICES_0_100
		this.CHOICES_SATURATION = this.CHOICES_0_100
		this.CHOICES_TINT = this.CHOICES_0_100
		this.CHOICES_SHARPNESS = this.CHOICES_0_100
		this.CHOICES_BACKLIGHT = this.CHOICES_0_100

		var tunnel = new PassThrough()
		var tmpdev = new LilliputD({ stream: tunnel }, { disconnect: true })
		//this.log('debug', 'LilliputD data ' + JSON.stringify(tmpdev.data.dev.command))
		const commands = this.processLilliputDData(tmpdev.data)
		//this.log('debug', 'Processed LilliputD data ' + JSON.stringify(commands))

		//this.log('debug', 'LilliputD source input ' + JSON.stringify(this.generateChoices(commands, 'source', 'source')))

		this.CHOICES_SOURCE = this.generateChoices(commands, 'source', 'source')

		this.CHOICES_SOURCE_MULTIVIEWER = this.generateChoices(commands, 'source', 'mv2-1')

		this.CHOICES_AUDIO_METER = this.generateChoices(commands, 'audio', 'meter')

		this.CHOICES_AUDIO_OUTPUT = this.generateChoices(commands, 'audio', 'right-left-out')

		this.CHOICES_PICTURE_COLOR_TEMP = this.generateChoices(commands, 'picture', 'color-temp')

		this.CHOICES_UMD_TALLY_UMD1 = this.generateChoices(commands, 'umd', 'tally-umd1')

		this.CHOICES_UMD_UMD3_UMD2 = this.generateChoices(commands, 'umd', 'umd3-umd2')

		this.CHOICES_UMD_UMDNUM_UMD4 = this.generateChoices(commands, 'umd', 'umdnum-umd4')

		this.PRESETS_SETTINGS = [
			{
				action: 'source',
				setting: 'source_name',
				feedback: 'source',
				label: '',
				choices: this.CHOICES_SOURCE,
				category: 'Source',
				additionalOptions: { mv2_1: 'SDI2-SDI1', mv4_3: 'SDI4-SDI3' },
			},
			{
				action: 'audio',
				setting: 'volume',
				feedback: 'volume',
				label: 'Volume ',
				choices: this.CHOICES_VOLUME,
				category: 'Audio',
				additionalOptions: { meter: 'None', output: '2-1' },
			},
			{
				action: 'picture',
				setting: 'backlight',
				feedback: 'backlight',
				label: 'Backlight ',
				choices: this.CHOICES_BACKLIGHT,
				category: 'Picture',
				additionalOptions: {
					brightness: 50,
					contrast: 50,
					saturation: 50,
					tint: 50,
					sharpness: 50,
					color_temp: '6500K',
				},
			},
			// TODO(Peter): Make these font size auto
			{
				action: 'umd',
				setting: 'tally_umd1',
				feedback: 'tally_umd1',
				label: 'Tally UMD1 ',
				choices: this.CHOICES_UMD_TALLY_UMD1,
				category: 'UMD',
				additionalOptions: { text: '', umd3_umd2: 'Off-Off', umdnum_umd4: '1-Off-White' },
			},
		]

		this.actions(this) // export actions
		this.init_variables()
		this.init_feedbacks()
		this.init_presets()
		this.init_udp()
	}

	configUpdated(config) {
		this.config = config

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.udp !== undefined) {
			try {
				this.udp.close()
			} catch (error) {
				this.log('error', 'Error closing UDP port: ' + error)
			} finally {
				delete this.udp
			}
		}

		this.init_udp()
	}

	init_udp() {
		let self = this

		if (self.dev !== undefined) {
			// TODO(Peter): Close any existing UDP socket
			//self.dev.process('#close')
			delete self.dev
		}

		if (!self.config.host) {
			self.updateStatus(InstanceStatus.BadConfig, `IP address is missing`)
			return
		} else if (!self.config.port) {
			self.updateStatus(InstanceStatus.BadConfig, `Target port is missing`)
			return
		} else if (!self.config.listen_port) {
			self.updateStatus(InstanceStatus.BadConfig, `Listen port is missing`)
			return
		}

		self.updateStatus(InstanceStatus.Connecting)

		// Disconnect = false to match the previous behaviour of the module, although we don't get as much connection feedback this way
		//self.dev = new LilliputD({ host: self.config.host, port: self.config.port }, { disconnect: false })
		// For now we just use the device to encode/decode so we can use createSharedUdpSocket
		var tunnel = new PassThrough()
		self.dev = new LilliputD({ stream: tunnel }, { disconnect: false })
		// self.dev.emitter.on('connectionData', (data) => self.log('debug', 'Conn Data ' + JSON.stringify(data)))
		self.dev.emitter.on('connectionStatus', (data) => {
			self.log('debug', 'Conn Status ' + JSON.stringify(data))
			if (data.status !== undefined && data.status != '') {
				switch (data.status) {
					case 'connected':
						self.updateStatus(InstanceStatus.Ok)
						break
					case 'closed':
						self.updateStatus(InstanceStatus.Disconnected)
						// Try to reconnect
						// TODO(Peter): Do some sort of backoff?
						if (self.dev !== undefined) {
							//self.dev.process('#connect')
						}
						break
					case 'error':
						// TODO(Peter): Extract more status
						// e.g. "more":{"errno":-104,"code":"ECONNRESET","syscall":"read"}
						self.updateStatus(InstanceStatus.UnknownError)
						break
					default:
						self.updateStatus(InstanceStatus.ConnectionFailure, 'Failed to connect - ' + data.status)
						break
				}
			} else {
				self.updateStatus(InstanceStatus.UnknownError, 'Unknown failure connecting')
			}
		})
		self.dev.emitter.on('commandForDevice', (data) => self.log('debug', 'Tx: ' + JSON.stringify(data)))
		self.dev.emitter.on('responseFromDevice', (data) => {
			self.log('debug', 'Rx: ' + JSON.stringify(data))
			// TODO(Peter): Deduplicate this
			self.updateStatus(InstanceStatus.Ok)
			// Handle updated data
			if (typeof data.value === 'object' || Array.isArray(data.value)) {
				for (var k in data.value) {
					if (k == 'format1') {
						let decodedText = ''
						for (let i = 1; i <= 18; i++) {
							if (data.value['format' + i] !== undefined) {
								decodedText += String.fromCharCode(data.value['format' + i])
								// Drop the now redundant original value
								delete data.value['format' + i]
							}
						}
						// Truncate on null and strip any trailing whitespace
						self.DATA['format'] = decodedText.replace(/\0.*$/, '').trimEnd()
					} else if (k == 'name1') {
						let decodedText = ''
						for (let i = 1; i <= 16; i++) {
							if (data.value['name' + i] !== undefined) {
								decodedText += String.fromCharCode(data.value['name' + i])
								// Drop the now redundant original value
								delete data.value['name' + i]
							}
						}
						// Truncate on null and strip any trailing whitespace
						self.DATA['name'] = decodedText.replace(/\0.*$/, '').trimEnd()
					} else {
						self.DATA[k] = data.value[k]
					}
				}
			} else {
				self.DATA[data.req] = data.value
			}
			self.log('debug', 'Overall data: ' + JSON.stringify(self.DATA))
			this.setVariableValues(self.DATA)
			this.checkFeedbacks('source')
			this.checkFeedbacks('volume')
			this.checkFeedbacks('brightness')
			this.checkFeedbacks('contrast')
			this.checkFeedbacks('saturation')
			this.checkFeedbacks('tint')
			this.checkFeedbacks('sharpness')
			this.checkFeedbacks('backlight')
			this.checkFeedbacks('color_temp')
			this.checkFeedbacks('tally_umd1')
		})

		self.log('debug', 'Binding to UDP port ' + self.config.listen_port)
		try {
			self.udp = self.createSharedUdpSocket('udp4', (msg, rinfo) => self.checkMessage(self, msg, rinfo))
			self.udp.bind(self.config.listen_port)

			self.udp.on('error', function (err) {
				self.updateStatus(InstanceStatus.ConnectionFailure, 'Network error: ' + err.message)
				self.log('error', 'Network error: ' + err.message)
			})

			self.udp.on('listening', function () {
				self.updateStatus(InstanceStatus.Connecting)
				self.log('info', 'Listening...')
				self.log('debug', 'Bound state: ' + JSON.stringify(self.udp.boundState))

				// We use lots of the statuses and expose the others as variables
				// It's also generally useful to trigger a connectionStatus message
				self.doAction('status?')

				// Test status data via loopback connection...
				//let buf = Buffer.from('5a470020010200fffe0001020304050602070400060000104000000400024e6f205369676e616c2020202020202020204d6f6e69746f72202020202020202020220210320109dd', 'hex')
				//self.udp.send(buf, Number(self.config.port), self.config.host)
			})
		} catch (error) {
			self.log('error', 'Error binding UDP Port: ' + error)
		}
	}

	checkMessage(self, msg, rinfo) {
		try {
			if (rinfo.address == self.config.host) {
				self.log('debug', 'Got UDP message: ' + Buffer.from(msg).toString('hex'))
				self.dev.decode(msg)
			} else {
				//if the remote address isn't our configured host, it's just some other monitor
				self.log('info', `Ignoring UDP message from unknown source: ${rinfo.address}:${rinfo.port}`)
			}
		} catch (err) {
			self.log('error', `UDP error: ${err.message}`)
		}
	}

	// Return config fields for web config
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				regex: Regex.IP,
			},
			{
				type: 'textinput',
				id: 'port',
				label: 'Target Port',
				width: 6,
				default: '19523',
				regex: Regex.PORT,
			},
			{
				type: 'textinput',
				id: 'listen_port',
				label: 'Listen Port',
				width: 6,
				default: '19522',
				regex: Regex.PORT,
			},
		]
	}

	// When module gets deleted
	destroy() {
		if (this.dev !== undefined) {
			//this.dev.process('#close')
			delete this.dev
		}

		if (this.udp !== undefined) {
			try {
				this.udp.close()
			} catch (error) {
				this.log('error', 'Error closing UDP port: ' + error)
			} finally {
				delete this.udp
			}
		}

		this.log('debug', 'destroy ' + this.id)
	}

	init_variables() {
		var variableDefinitions = []

		variableDefinitions.push({
			name: 'Name',
			variableId: 'name',
		})

		variableDefinitions.push({
			name: 'Format',
			variableId: 'format',
		})

		variableDefinitions.push({
			name: 'Source',
			variableId: 'source',
		})

		variableDefinitions.push({
			name: 'Multiviewer 2-1',
			variableId: 'mv2-1',
		})

		variableDefinitions.push({
			name: 'Multiviewer 4-3',
			variableId: 'mv4-3',
		})

		variableDefinitions.push({
			name: 'Volume',
			variableId: 'volume',
		})

		variableDefinitions.push({
			name: 'Brightness',
			variableId: 'brightness',
		})

		variableDefinitions.push({
			name: 'Contrast',
			variableId: 'contrast',
		})

		variableDefinitions.push({
			name: 'Saturation',
			variableId: 'saturation',
		})

		variableDefinitions.push({
			name: 'Tint',
			variableId: 'tint',
		})

		variableDefinitions.push({
			name: 'Sharpness',
			variableId: 'sharpness',
		})

		variableDefinitions.push({
			name: 'Backlight',
			variableId: 'backlight',
		})

		variableDefinitions.push({
			name: 'Color Temperature',
			variableId: 'color_temp',
		})

		// TODO(Peter): Add and expose other variables

		this.setVariableDefinitions(variableDefinitions)
	}

	init_feedbacks() {
		// feedbacks
		var feedbacks = []

		feedbacks['source'] = {
			type: 'boolean',
			name: 'Source',
			description: 'If the source specified is the current source, give feedback',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source_name',
					choices: this.CHOICES_SOURCE,
					default: this.CHOICES_SOURCE.length > 0 ? this.CHOICES_SOURCE[0].id : '',
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.source == feedback.options.source_name
			},
		}

		feedbacks['volume'] = {
			type: 'boolean',
			name: 'Volume',
			description: 'If the system volume is at the selected volume, give feedback',
			options: [
				{
					type: 'number',
					label: 'Volume',
					id: 'volume',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.volume == parseInt(feedback.options.volume)
			},
		}

		feedbacks['contrast'] = {
			type: 'boolean',
			name: 'Contrast',
			description: 'If the system contrast is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: 'Contrast',
					id: 'contrast',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.contrast == parseInt(feedback.options.contrast)
			},
		}

		feedbacks['brightness'] = {
			type: 'boolean',
			name: 'Brightness',
			description: 'If the system brightness is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: 'Brightness',
					id: 'brightness',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.brightness == parseInt(feedback.options.brightness)
			},
		}

		feedbacks['sharpness'] = {
			type: 'boolean',
			name: 'Sharpness',
			description: 'If the system sharpness is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: '',
					id: '',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.sharpness == parseInt(feedback.options.sharpness)
			},
		}

		feedbacks['saturation'] = {
			type: 'boolean',
			name: 'Saturation',
			description: 'If the system saturation is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: 'Saturation',
					id: 'saturation',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.saturation == parseInt(feedback.options.saturation)
			},
		}

		feedbacks['tint'] = {
			type: 'boolean',
			name: 'Tint',
			description: 'If the system tint is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: 'Tint',
					id: 'tint',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.tint == parseInt(feedback.options.tint)
			},
		}

		feedbacks['backlight'] = {
			type: 'boolean',
			name: 'Backlight',
			description: 'If the system backlight is at the selected level, give feedback',
			options: [
				{
					type: 'number',
					label: 'Backlight',
					id: 'backlight',
					default: 50,
					min: 0,
					max: 100,
					required: true,
					step: 1,
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA.backlight == parseInt(feedback.options.backlight)
			},
		}

		feedbacks['color_temp'] = {
			type: 'boolean',
			name: 'Color Temperature',
			description: 'If the color temperature is in the specified state, give feedback',
			options: [
				{
					type: 'dropdown',
					label: 'Color Temperature',
					id: 'color_temp',
					choices: this.CHOICES_PICTURE_COLOR_TEMP,
					default: this.CHOICES_PICTURE_COLOR_TEMP.length > 0 ? this.CHOICES_PICTURE_COLOR_TEMP[0].id : '',
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA['color-temp'] == feedback.options.color_temp
			},
		}

		feedbacks['tally_umd1'] = {
			type: 'boolean',
			name: 'Tally Color - UMD1',
			description: 'If tally color and UMD1 are in the specified states, give feedback',
			options: [
				{
					type: 'dropdown',
					label: 'Tally UMD1',
					id: 'tally_umd1',
					choices: this.CHOICES_UMD_TALLY_UMD1,
					default: this.CHOICES_UMD_TALLY_UMD1.length > 0 ? this.CHOICES_UMD_TALLY_UMD1[0].id : '',
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 255, 0),
			},
			callback: (feedback) => {
				return this.DATA['tally-umd1'] == feedback.options.tally_umd1
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	init_presets() {
		let presets = []

		for (var type in this.PRESETS_SETTINGS) {
			for (var choice in this.PRESETS_SETTINGS[type].choices) {
				var optionData = {}
				if (this.PRESETS_SETTINGS[type].additionalOptions !== undefined) {
					for (var opt in this.PRESETS_SETTINGS[type].additionalOptions) {
						optionData[opt] = this.PRESETS_SETTINGS[type].additionalOptions[opt]
					}
				}
				optionData[this.PRESETS_SETTINGS[type].setting] = this.PRESETS_SETTINGS[type].choices[choice].id

				presets[`${this.PRESETS_SETTINGS[type].action}_${this.PRESETS_SETTINGS[type].choices[choice].id}`] = {
					category: this.PRESETS_SETTINGS[type].category,
					name: this.PRESETS_SETTINGS[type].label + this.PRESETS_SETTINGS[type].choices[choice].label,
					type: 'button',
					style: {
						text: this.PRESETS_SETTINGS[type].label + this.PRESETS_SETTINGS[type].choices[choice].label,
						size: '14',
						color: combineRgb(255, 255, 255),
						bgcolor: combineRgb(0, 0, 0),
					},
					feedbacks: [
						{
							feedbackId: this.PRESETS_SETTINGS[type].feedback,
							style: {
								bgcolor: combineRgb(255, 255, 0),
								color: combineRgb(0, 0, 0),
							},
							options: optionData,
						},
					],
					steps: [
						{
							down: [
								{
									actionId: this.PRESETS_SETTINGS[type].action,
									options: optionData,
								},
							],
							up: [],
						},
					],
				}
			}
		}

		this.setPresetDefinitions(presets)
	}

	actions(system) {
		system.setActionDefinitions({
			source: {
				name: 'Source',
				options: [
					{
						type: 'dropdown',
						label: 'Source',
						id: 'source_name',
						choices: system.CHOICES_SOURCE,
						default: system.CHOICES_SOURCE.length > 0 ? system.CHOICES_SOURCE[0].id : '',
					},
					{
						type: 'dropdown',
						label: 'MV2-1',
						id: 'mv2_1',
						choices: system.CHOICES_SOURCE_MULTIVIEWER,
						default: system.CHOICES_SOURCE_MULTIVIEWER.length > 0 ? system.CHOICES_SOURCE_MULTIVIEWER[0].id : '',
					},
					{
						type: 'dropdown',
						label: 'MV4-3',
						id: 'mv4_3',
						choices: system.CHOICES_SOURCE_MULTIVIEWER,
						default: system.CHOICES_SOURCE_MULTIVIEWER.length > 0 ? system.CHOICES_SOURCE_MULTIVIEWER[0].id : '',
					},
				],
				callback: async (action) => {
					await system.doAction(
						'source ' + action.options.source_name + ',' + action.options.mv2_1 + ',' + action.options.mv4_3,
					)
				},
			},
			audio: {
				name: 'Audio',
				options: [
					{
						type: 'number',
						label: 'Volume',
						id: 'volume',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'dropdown',
						label: 'Meter',
						id: 'meter',
						choices: system.CHOICES_AUDIO_METER,
						default: system.CHOICES_AUDIO_METER.length > 0 ? system.CHOICES_AUDIO_METER[0].id : '',
					},
					{
						type: 'dropdown',
						label: 'Output (Right, Left)',
						id: 'output',
						choices: system.CHOICES_AUDIO_OUTPUT,
						default: system.CHOICES_AUDIO_OUTPUT.length > 0 ? system.CHOICES_AUDIO_OUTPUT[0].id : '',
					},
				],
				callback: async (action) => {
					await system.doAction(
						'audio ' + action.options.volume + ',' + action.options.meter + ',' + action.options.output,
					)
				},
			},
			picture: {
				name: 'Picture',
				options: [
					{
						type: 'number',
						label: 'Brightness',
						id: 'brightness',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'number',
						label: 'Contrast',
						id: 'contrast',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'number',
						label: 'Saturation',
						id: 'saturation',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'number',
						label: 'Tint',
						id: 'tint',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'number',
						label: 'Sharpness',
						id: 'sharpness',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'number',
						label: 'Backlight',
						id: 'backlight',
						default: 50,
						min: 0,
						max: 100,
						required: true,
						step: 1,
					},
					{
						type: 'dropdown',
						label: 'Color Temp',
						id: 'color_temp',
						choices: system.CHOICES_PICTURE_COLOR_TEMP,
						default: system.CHOICES_PICTURE_COLOR_TEMP.length > 0 ? system.CHOICES_PICTURE_COLOR_TEMP[0].id : '',
					},
				],
				callback: async (action) => {
					await system.doAction(
						'picture ' +
							action.options.brightness +
							',' +
							action.options.contrast +
							',' +
							action.options.saturation +
							',' +
							action.options.tint +
							',' +
							action.options.sharpness +
							',' +
							action.options.backlight +
							',' +
							action.options.color_temp,
					)
				},
			},
			umd: {
				name: 'UMD',
				options: [
					{
						type: 'dropdown',
						label: 'Tally Color-UMD1',
						id: 'tally_umd1',
						choices: system.CHOICES_UMD_TALLY_UMD1,
						default: system.CHOICES_UMD_TALLY_UMD1.length > 0 ? system.CHOICES_UMD_TALLY_UMD1[0].id : '',
					},
					{
						type: 'textinput',
						label: 'Text',
						id: 'text',
						default: '',
					},
					{
						type: 'dropdown',
						label: 'UMD3-UMD2',
						id: 'umd3_umd2',
						choices: system.CHOICES_UMD_UMD3_UMD2,
						default: system.CHOICES_UMD_UMD3_UMD2.length > 0 ? system.CHOICES_UMD_UMD3_UMD2[0].id : '',
					},
					{
						type: 'dropdown',
						label: 'UMD Number-UMD4',
						id: 'umdnum_umd4',
						choices: system.CHOICES_UMD_UMDNUM_UMD4,
						default: system.CHOICES_UMD_UMDNUM_UMD4.length > 0 ? system.CHOICES_UMD_UMDNUM_UMD4[0].id : '',
					},
				],
				callback: async (action) => {
					var text = action.options.text
					var encodedText = ''
					for (var i = 0; i < 16; i++) {
						if (i < text.length) {
							encodedText += ',0x' + text.charCodeAt(i).toString(16)
						} else {
							encodedText += ',0x20'
						}
					}
					await system.doAction(
						'umd ' +
							action.options.tally_umd1 +
							encodedText +
							',' +
							action.options.umd3_umd2 +
							',' +
							action.options.umdnum_umd4,
					)
				},
			},
			customCommand: {
				name: 'Custom Command',
				options: [
					{
						type: 'textinput',
						label: 'Command',
						id: 'command',
						default: 'volume $(internal:time_s)',
						useVariables: true,
					},
				],
				callback: async (action, context) => {
					const command = await context.parseVariablesInString(action.options.command)
					await system.doAction(command)
				},
			},
		})
	}

	doAction(cmd) {
		let self = this
		if (cmd !== undefined && cmd != '') {
			self.log('debug', 'sending "' + cmd + '" to ' + this.config.host)

			// This is using parts of the library that aren't publicly exposed and may change
			if (
				this.dev !== undefined &&
				// && this.dev.mode == 'udp'
				// && this.dev.socket !== undefined
				this.udp !== undefined
				// TODO(Peter): better check UDP connected status
				// && this.udp.boundState ==
			) {
				//this.dev.process(cmd)
				let cmdo = self.dev.encode(cmd)
				this.udp.send(cmdo.encoded, Number(self.config.port), self.config.host)
				this.log('debug', 'Sent via UDP!')
			} else {
				// TODO(Peter): Should probably allow the internal # commands through regardless here
				this.log('debug', 'Socket not connected :(')
			}
		}
	}
}
runEntrypoint(LilliputMonitorInstance, UpgradeScripts)
