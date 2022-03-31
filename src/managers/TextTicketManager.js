const Discord = require('discord.js');
const Errors = require('../utils/Errors');
const EventEmitter = require('node:events');
const FileSystem = require('node:fs');
const TextTicket = require('../structures/TextTicket');

/**
 * @typedef {Object} RawTextTicketData
 * @property {Discord.Snowflake} channelId The id of the ticket channel
 * @property {Discord.Snowflake} creatorId The id of the creator of the ticket
 * @property {Discord.Snowflake} guildId The id of the guild of the ticket
 * @property {Number} number The number of the ticket
 * @property {Array<Discord.Snowflake} participants The participants of the ticket
 * @property {String} status The status of the ticket
 */

/**
 * @typedef {Object} TextTicketManagerOptions
 * @property {?String} channelTopic The topic of the ticket channel
 * @property {?Discord.Snowflake} closedParentId The id of the closed ticket category (Default: options.parentId)
 * @property {Discord.Snowflake} parentId The id of the parent category
 * @property {?Array<Discord.Snowflake>} staffRoles The ids of the staff roles
 * @property {String} storage The JSON file where the tickets should get stored
 */

/**
 * The ticket manager for text tickets
 * @extends {EventEmitter}
 */
class TextTicketManager extends EventEmitter {

    /**
     * The constructor of the TextTicketManager
     * @param {Discord.Client} client The client
     * @param {TextTicketManagerOptions} options The options for the TextTicketManager
     */
    constructor(client, options = { channelTopic: ' ', closedParentId: null, parentId: null, staffRoles: new Array(), storage: undefined }) {

        super();
        
        if(!client || !client instanceof Discord.Client) throw new Error(Errors.INVALID_CLIENT);

        /**
         * The discord client
         * @type {Discord.Client}
         */
        this.client = client;

        if(!options ||
            !options?.parentId ||
            !options?.storage
        ) throw new Error(Errors.MISSING_OPTIONS);

        /**
         * The options
         * @type {TextTicketManagerOptions}
         */
        this.options = options;

        options.closedParentId = options.closedParentId ?? options.parentId

        /**
         * The collection of all tickets
         * @type {Discord.Collection<Number, TextTicket>}
         */
        this.tickets = new Discord.Collection();

        /**
         * @type {Array<RawTextTicketData>}
         */
        this._rawTickets = new Array();

        /**
         * If the tickets are loaded
         * @type {Boolean}
         */
        this.ready = false;

        this._init();

    }

    /**
     * @private
     */
    async _init() {

        const loadedTickets = await this._loadAllTickets();
        
        this._rawTickets = loadedTickets

        for(const rawTicket of this._rawTickets) {

            const textTicket = new TextTicket(this, rawTicket);

            this.tickets.set(textTicket.number, textTicket);

        }

        this.ready = true;

    }

    /**
     * @private
     */
    async _loadAllTickets() {
        
        const storage = await require('util').promisify(FileSystem.exists)(this.options.storage);

        if(!storage) {

            await require('util').promisify(FileSystem.writeFile)(this.options.storage, JSON.stringify(new Array()), 'utf-8');
            
            return [];

        } else {

            const storageContent = await require('util').promisify(FileSystem.readFile)(this.options.storage);

            try {

                const storageTickets = await JSON.parse(storageContent.toString());

                if(Array.isArray(storageTickets)) {

                    return storageTickets;

                } else {

                    return [];

                }

            } catch (e) {

                return [];

            }

        }

    }

    /**
     * @private
     */
    async _saveRawTickets() {

        await require('util').promisify(FileSystem.writeFile)(this.options.storage, JSON.stringify(this._rawTickets, null, 4), 'utf-8');

        return true;

    }

    /**
     * Checks if a member has multiple tickets
     * @param {Discord.Snowflake} guildId 
     * @param {Discord.Snowflake} userId 
     * @returns {Boolean}
     */
    checkDoubleTickets(guildId, userId) {

        return !!this._rawTickets.find((rawTicket) => rawTicket.guildId === guildId && rawTicket.creatorId === userId);

    }

    /**
     * Closes a ticket
     * @param {TextTicket} ticket 
     */
    async closeTicket(ticket) {

        if(!this.ready) throw new Error(Errors.NOT_READY);

        if(!ticket instanceof TextTicket) throw new Error(Errors.INVALID_TICKET);

        const closedTicketCategory = ticket.guild.channels.resolve(this.options.closedParentId);

        if(!closedTicketCategory) throw new Error(Errors.INVALID_CATEGORY);

        const ticketPermissions = [];

        ticketPermissions.push({ id: ticket.creatorId, deny: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] }, { id: ticket.guild.roles.everyone, deny: ['VIEW_CHANNEL'] });

        for(const staffRole of this.options.staffRoles ?? []) {

            const resolvedStaffRole = ticket.guild.roles.resolve(staffRole);

            if(resolvedStaffRole) ticketPermissions.push({ id: resolvedStaffRole, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] });

        }

        await ticket.channel.edit({

            parent: closedTicketCategory,
            permissionOverwrites: ticketPermissions,
            name: `closed-${ticket.number}`,

        });

        ticket._data.status = 'closed';

        const newTicket = new TextTicket(this, ticket._data);

        this.tickets.set(newTicket.number, newTicket);
        this._rawTickets[this._rawTickets.indexOf(ticket._data)] = ticket._data;

        await this._saveRawTickets();

        /**
         * Emitted when a ticket gets closed
         * @event TextTicketManager#ticketClosed
         * @param {TextTicket} ticket The closed ticket
         */
        this.emit('ticketClosed', newTicket);

        return newTicket;

    }

    /**
     * 
     * @param {Discord.GuildResolvable} guild 
     * @param {Discord.UserResolvable} user 
     * @returns {TextTicket|null}
     */
    async createTicket(guild, user) {

        if(!this.ready) throw new Error(Errors.NOT_READY);

        const resolvedGuild = this.client.guilds.resolve(guild);
        const resolvedUser = this.client.users.resolve(user);
        const resolvedMember = resolvedGuild.members.resolve(resolvedUser);

        if(!resolvedGuild || !resolvedUser || !resolvedMember) throw new Error(Errors.NOT_RESOLVABLE)

        const ticketCategory = resolvedGuild.channels.resolve(this.options.parentId);

        if(!ticketCategory || ticketCategory?.type !== 'GUILD_CATEGORY') throw new Error(Errors.INVALID_CATEGORY);

        const guildTickets = this._rawTickets.filter((rawTicket) => rawTicket.guildId === resolvedGuild.id);

        let ticketNumber = 0;

        if(guildTickets.length > 0) ticketNumber = guildTickets.sort((a, b) => b.number - a.number)[0].number;

        const newTicketNumber = (parseInt(String(ticketNumber)) + 1).toString();
        const ticketPermissions = [];

        ticketPermissions.push({ id: resolvedMember.id, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] }, { id: resolvedGuild.roles.everyone, deny: ['VIEW_CHANNEL'] });

        for(const staffRole of this.options.staffRoles ?? []) {

            const resolvedStaffRole = resolvedGuild.roles.resolve(staffRole);

            if(resolvedStaffRole) ticketPermissions.push({ id: resolvedStaffRole, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] });

        }

        const ticketChannel = await resolvedGuild.channels.create(`ticket-${newTicketNumber}`, {
        
            parent: ticketCategory.id,
            permissionOverwrites: ticketPermissions,
            topic: this.options.channelTopic ?? '',
            type: 'GUILD_TEXT',
            
        });

        const ticket = new TextTicket(this, {
            channelId: ticketChannel.id,
            creatorId: resolvedUser.id,
            guildId: resolvedGuild.id,
            number: newTicketNumber,
            participants: [],
            status: 'open'
        });

        this._rawTickets.push(ticket._data);

        await this._saveRawTickets();

        this.tickets.set(ticket.number, ticket);

        
        /**
         * Emitted when a ticket gets created
         * @event TextTicketManager#ticketCreated
         * @param {TextTicket} ticket The created ticket
         */
        this.emit('ticketCreated', ticket);

        return ticket;

    }

    /**
     * Deletes a ticket
     * @param {TextTicket} ticket
     * @returns {Boolean}
     */
    async deleteTicket(ticket) {

        if(!this.ready) throw new Error(Errors.NOT_READY);

        if(!ticket instanceof TextTicket) throw new Error(Errors.INVALID_TICKET);

        await ticket.channel.delete();

        this._rawTickets = this._rawTickets.filter((rawTicket) => rawTicket.channelId !== ticket.channelId);

        await this._saveRawTickets();

        this.tickets.delete(ticket.number);

        /**
         * Emitted when a ticket gets deleted
         * @event TextTicketManager#ticketDeleted
         * @param {TextTicket} ticket The deleted ticket
         */
        this.emit('ticketDeleted', ticket);

        return true;

    }

    /**
     * Renames a ticket
     * @param {TextTicket} ticket
     * @param {String} newName
     * @returns {TextTicket}
     */
    async renameTicket(ticket, newName) {

        if(!this.ready) throw new Error(Errors.NOT_READY);

        if(!ticket instanceof TextTicket) throw new Error(Errors.INVALID_TICKET);

        await ticket.channel.edit({ name: `${newName}-${ticket.number}` });

        /**
         * Emitted when a ticket gets renamed
         * @event TextTicketManager#ticketRenamed
         * @param {TextTicket} ticket The renamed ticket
         */
        this.emit('ticketRenamed', ticket);

        return ticket;

    }

    /**
     * Reopens a ticket
     * @param {TextTicket} ticket
     * @returns {TextTicket}
     */
    async reopenTicket(ticket) {

        if(!this.ready) throw new Error(Errors.NOT_READY);

        if(!ticket instanceof TextTicket) throw new Error(Errors.INVALID_TICKET);

        const ticketCategory = ticket.guild.channels.resolve(this.options.parentId);

        if(!ticketCategory || ticketCategory?.type !== 'GUILD_CATEGORY') throw new Error(Errors.INVALID_CATEGORY);

        const ticketPermissions = [];

        ticketPermissions.push({ id: ticket.creatorId, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] }, { id: ticket.guild.roles.everyone, deny: ['VIEW_CHANNEL'] });

        for(const staffRole of this.options.staffRoles ?? []) {

            const resolvedStaffRole = ticket.guild.roles.resolve(staffRole);

            if(resolvedStaffRole) ticketPermissions.push({ id: resolvedStaffRole, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'ATTACH_FILES', 'ADD_REACTIONS', 'READ_MESSAGE_HISTORY'] });

        }

        await ticket.channel.edit({ name: `ticket-${ticket.number}`, permissionOverwrites: ticketPermissions });

        ticket._data.status = 'open';

        const newTicket = new TextTicket(this, ticket._data);

        this.tickets.set(newTicket.number, newTicket);
        this._rawTickets[this._rawTickets.indexOf(ticket._data)] = ticket._data;

        await this._saveRawTickets();

        /**
         * Emitted when a ticket gets reopened
         * @event TextTicketManager#ticketReopened
         * @param {TextTicket} ticket The reopened ticket
         */
        this.emit('ticketReopened', newTicket);

        return newTicket;


    }

}

module.exports = TextTicketManager;